# Aimbot Rules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three aimbot rules learned from the nepmir ground truth (A: headshot share, B: LilAC big snap, C: flick and return), with escalation to one pinged `aimbot_multi` flag when two fire in one match, fed by a new `k=sikill` line from `l4d_inputstats` 0.4.0.

**Architecture:** Rule B is a severity mapping applied where LilAC flags are already stored in `src/server.ts`, so it ships first and alone. `l4d_inputstats` 0.4.0 keeps a per-survivor ring of usercmd view angles and, on each human SI kill, emits one signed `L4DM ... k=sikill ... v=3` line one second later; the site parses it into a new `si_kills` table. A new module `src/aimRules.ts` evaluates A and C once per ended match from the one-minute sweep (its own claim table `aim_match_scans`, beside `scanEndedMatches`), reads B's rows for escalation, writes `integrity_flags` rows (source `aim`) and returns what to post. Posting goes through a new `aim_flag` admin event to the mod channel, pinging the mod call role for `aimbot_multi`. A setting `aim_rules` (`off` | `log` | `on`, default `log`) gates A, C and escalation; B is always on.

**Tech Stack:** TypeScript (Fastify, better-sqlite3, vitest), Preact (web), SourcePawn 1.12 (`plugin/l4d_inputstats.sp` 0.3.0 to 0.4.0) compiled with wine and the Rotoblin tree's spcomp.

**Spec:** `docs/superpowers/specs/2026-10-17-aimbot-rules-design.md` (owner-approved). Companion: `docs/superpowers/specs/2026-10-17-evader-fingerprints-design.md`, whose "cheat flag" second sign reads the kinds this plan writes.

## Global Constraints

- Never use em dashes anywhere: code, comments, docs, commit messages, Discord lines. Replace by meaning (a colon, a comma, "so", parentheses).
- Match surrounding code: comment density, naming, idioms. Commit messages are one plain sentence.
- Flag kinds are exactly `hs_share`, `flick_return`, `aimbot_multi` (the evader fingerprints plan reads them from `integrity_flags`). LilAC rows keep their LilAC kind (`aimbot`); rule B only changes their severity to `high`.
- Rule thresholds, verbatim from the spec: A fires at >= 10 kills in a group AND P(X >= headshots | n, p_group) < 1e-3; p_group pools the trailing 30 days; fixed at 0.367 for `auto` until 500 kills exist in the group. B: LilAC aimbot flag with `ldelta >= 60` is stored `high` instead of `suspected`. C: `pre >= 90` and `back` within 45 degrees, at >= 2 such kills in one match. Escalation: any two of A/B/C in one match make one `aimbot_multi` row, severity `high`, posted to the mod channel with the mod-role ping; any one alone is its own flag, posted, no ping.
- Nothing bans, holds or kicks anyone. Every rule is evidence for staff.
- Settings: `aim_rules` with values `off` | `log` | `on`. `log` writes flags but does not post them. Ships as `log`. B is always on and is not governed by `aim_rules`.
- The sikill wire line, verbatim: `L4DM id=<steamid64> k=sikill w=<weapon> hs=<0|1> dist=<units> pre=<deg> back=<deg> cls=<victim class> v=3`. The other L4DM kinds stay on `v=2` (`src/logParse.ts` requires it on stall lines), so the plugin's `WIRE_VERSION` must NOT change; the sikill line has its own constant.
- `PLUGIN_VERSION` of `l4d_inputstats` goes `0.3.0` to `0.4.0`.
- Tests: `npx vitest run <path>` per file, `npm test` for everything, `npm run typecheck` (both the server and web tsconfig).
- Other sessions have uncommitted edits in this checkout (`ops/README.md`, `ops/pug-db-backup.sh` and possibly more). Never `git commit -a`, never `git add -A` or `git add .`, never bare `git stash`. Stage only the files the task names: `git add <files> && git commit -m "..." -- <files>`.
- Never ssh anywhere, never rcon, restart or stage a production box, never run `deploy-web.sh` or `stage-on-restart.sh`. The plan ends at committed code, a compiled `.smx` and the Rollout checklist, which needs the owner's explicit go-ahead before any of it runs.
- Local plugin tests only on the shared local server under `/home/volence/l4d1-ds` (rcon port 27055). Other sessions and the owner use it: run `status` first and touch nothing while it shows a human you did not put there; never restart or kill a srcds you did not start; kill only by PID. It is `sv_lan 1`, so the plugin sends the `STEAM_` id form there.

## Review Focus

These are the inputs the spec implies but does not spell out, most likely to bite first. Each has a test in the task that owns the code.

1. A kill line for a survivor who is not rostered in a live match (warmup, spectator box, practice lease): dropped, never stored, so it cannot leak into a pool or a match. Test in Task 4.
2. The one-minute sweep visiting the same ended match again (a second tick, a web restart): one set of rows and one post per match, never two. Test in Task 7.
3. Switching `aim_rules` from `log` to `on` a week later: the week of logged flags stays on file and is NOT posted then. Test in Task 7.
4. A LilAC line LilAC itself banned on, with a big ldelta: stays `banned`, never downgraded to `high`; an `aimlock` or `bhop` line is never `high` whatever it carries. Test in Task 1.
5. The pooled headshot rate must not include the very match being judged (a cheater's own kills would drag the pool toward them), and weapons that arrive as `weapon_smg` must pool with `smg`. Tests in Task 5.

## Spec gaps and readings this plan makes (flag to the owner, not decided by them)

1. **The M16 is in no group.** The spec's `rifle` group is `hunting_rifle` only; the game's M16 weapon name is literally `rifle`. This plan stores M16 kills and evaluates them under no group (same as shotguns). The group name `rifle` is kept from the spec; it means the hunting rifle.
2. **`rifle` group starts disabled.** The spec says its rate "is measured before it is enabled" without saying how it is enabled. This plan defines it with `enabled: false` and no fallback; Task 12's calibration report prints its pooled rate so the owner can set it.
3. **`pre` and `back` use different reference views.** `pre` is the largest distance between the kill-tick view and any view in the previous 300 ms; `back` is measured against "the view 300 ms before the kill". This plan implements both literally (the reference for `back` is the oldest ring entry inside the 300 ms window). For a flick these are the same point; for a slow turn followed by a snap they differ. Rule C uses `pre` for the spec's "moved >= 90 in total angular distance".
4. **"Map times" for rule C.** The line carries no game clock. The flag text gives the site's arrival time (UTC, `HH:MM:SS`), which is within about a second of the kill plus the 1 s look back.
5. **Bot victims in the local test.** The spec's kill record requires a human SI, but its own plugin test kills a bot SI. This plan admits bot victims and bot attackers only while the existing TEST ONLY cvar `l4d_inputstats_bots 1` is set.
6. **`log` mode also silences escalation.** With `aim_rules log`, an A+B match writes `aimbot_multi` but posts nothing (B's own LilAC line still posts live). A nepmir repeat during the log week would therefore not ping. The owner should know before shipping.
7. **Claim table.** The spec says A and C run "inside the same end-of-match sweep (`scanEndedMatches`)". `scanEndedMatches` only visits matches with bhop bursts and returns `input_flag` rows, so this plan runs `scanAimMatches` from the same one-minute reaper, right after it, with its own claim table `aim_match_scans`. Same timing guarantee (whole matches only).
8. **Source name `aim`.** Rows from A, C and escalation use `integrity_flags.source = 'aim'`. `'analyzer'` cannot be reused: `src/admin/timeline/analyzer.ts` labels every `source = 'analyzer'` flag as `newcomer_esp`.
9. **Log-mode flags are on the file, not in Needs a look.** While `aim_rules` is not `on`, the timeline marks aim rows `allowed` (on file, never evidence), like the uncalibrated `hidden_track` clips. When it goes `on`, all of them count.
10. **When `aimbot_multi` fires, the individual `hs_share` / `flick_return` rows are still written** (so the evader plan sees each rule) but only the multi row posts.
11. **Attacker team change during the 1 s window** emits `back=-1`, like disconnect and death (the spec names only those two).
12. **Severity of `hs_share` and `flick_return`** is `suspected`; only `aimbot_multi` and B's LilAC rows are `high`. The evader spec says "a high-severity kind added by the aimbot spec"; the evader plan should read the three kinds by name, as the caller asked.
13. **Ring size at 128 tick.** 40 usercmds is 400 ms at 100 tick but 312 ms at 128 (riverside-3 runs 128 updates/s). Still covers 300 ms; kept at 40 as the spec says.
14. **The 500-kill switch counts the trailing 30 days**, excluding the judged match.

---

## File Structure

- `src/aimRules.ts` (new): everything the rules know. Rule B (`BIG_SNAP_DEG`, `isBigSnap`, `lilacSeverity`), SI kill storage (`recordSiKill`), rule A (`binomialTail`, `HS_GROUPS`, `groupOf`, `pooledRate`, `hsShare`, `hsNote`), rule C (`isFlickReturn`, `flickReturns`, `flickNote`), mode (`aimRulesMode`), per-match evaluation and escalation (`evaluateAimMatch`) and the sweep (`scanAimMatches`).
- `src/aimCalibration.ts` (new): the one-week calibration report over `si_kills`, pure over the DB.
- `scripts/aim-calibration.ts` (new): prints that report.
- `src/logParse.ts`: `si_kill` event and the `k=sikill` branch.
- `src/logListener.ts`, `src/aliases.ts`, `src/mergePlayers.ts`: admit, canonicalise and merge the new kind and table.
- `src/db.ts`: `si_kills`, `aim_match_scans`, `aim_rules` default.
- `src/settingsSchema.ts`: the `aim_rules` choice.
- `src/integrityFlags.ts`: `FlagSeverity` gains `'high'`.
- `src/server.ts`: B in the LilAC handler, the `si_kill` handler, the sweep call.
- `src/adminFeed.ts`, `src/discord/feedRouting.ts`, `src/discord/adminFeedPoster.ts`: `lilac_flag.bigSnap`, new `aim_flag` kind.
- `src/admin/timeline/aim.ts` (new), `src/admin/timeline/types.ts`, `src/admin/timeline/lilac.ts`, `src/admin/playerTimeline.ts`, `src/admin/arrived.ts`: staff file surfaces.
- `web/src/api.ts`, `web/src/routes/admin/file/GlanceRow.tsx`, `web/src/routes/admin/file/EvidenceDetail.tsx`, `web/src/routes/admin/StaffGuide.tsx`: web labels and the guide.
- `plugin/l4d_inputstats.sp`: 0.4.0. `plugin/build-inputstats.sh` (new): the build script it never had. `plugin/TESTING.md`: the sikill runbook.
- Tests (new): `tests/aimBigSnap.test.ts`, `tests/siKillParse.test.ts`, `tests/siKills.test.ts`, `tests/aimHeadshots.test.ts`, `tests/aimFlicks.test.ts`, `tests/aimRules.test.ts`, `tests/aimFeed.test.ts`, `tests/aimTimeline.test.ts`, `tests/aimCalibration.test.ts`. Modified: `tests/db.test.ts`, `web/src/routes/playerFile.test.tsx`.

---

### Task 1: Rule B, the LilAC big snap (ships first)

**Files:**
- Create: `src/aimRules.ts`
- Modify: `src/integrityFlags.ts` (the `FlagSeverity` type)
- Modify: `src/server.ts:920-944` (the `lilac_flag` handler), imports near line 91
- Modify: `src/adminFeed.ts` (the `lilac_flag` variant)
- Modify: `src/discord/adminFeedPoster.ts` (`case 'lilac_flag'`)
- Test: `tests/aimBigSnap.test.ts`

**Interfaces:**
- Consumes: `LilacReason` from `src/logParse.ts`; `FlagSeverity` from `src/integrityFlags.ts`.
- Produces: `BIG_SNAP_DEG = 60`; `isBigSnap(kind: string, reason: LilacReason | undefined): boolean`; `lilacSeverity(kind: string, banned: boolean, reason?: LilacReason): FlagSeverity`; `FlagSeverity = 'suspected' | 'banned' | 'high'`; `AdminEvent` `lilac_flag` gains `bigSnap?: number`.

- [ ] **Step 1: Write the failing tests**

Create `tests/aimBigSnap.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import dgram from 'node:dgram';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { addServer } from '../src/serverPool.js';
import { upsertPlayer } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { publishAdminEvent, subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import { AdminFeedPoster } from '../src/discord/adminFeedPoster.js';
import { BIG_SNAP_DEG, isBigSnap, lilacSeverity } from '../src/aimRules.js';
import { FakeTransport } from './fakes/fakeTransport.js';

const P = '76561198129925325';

let db: DB;
beforeEach(() => { db = openDb(':memory:'); upsertPlayer(db, { steamid: P, name: 'nepmir', avatar: null }, []); });

describe('rule B, the big snap', () => {
  it('is 60 degrees', () => {
    expect(BIG_SNAP_DEG).toBe(60);
  });

  it('marks an aimbot flag at or over 60 degrees high', () => {
    expect(lilacSeverity('aimbot', false, { lflags: 4, ldelta: 143.5 })).toBe('high');
    expect(lilacSeverity('aimbot', false, { ldelta: 60 })).toBe('high');
    expect(lilacSeverity('aimbot', false, { ldelta: 59.9 })).toBe('suspected');
  });

  it('leaves an unknown, missing or empty reason suspected', () => {
    expect(lilacSeverity('aimbot', false, { ldelta: -1 })).toBe('suspected');
    expect(lilacSeverity('aimbot', false, {})).toBe('suspected');
    expect(lilacSeverity('aimbot', false)).toBe('suspected');
  });

  // Review Focus 4: LilAC's own ban is never downgraded, and only the
  // aimbot check measures an aim-snap.
  it('keeps a LilAC ban banned and never marks another cheat high', () => {
    expect(lilacSeverity('aimbot', true, { ldelta: 143.5 })).toBe('banned');
    expect(lilacSeverity('aimlock', false, { ldelta: 143.5 })).toBe('suspected');
    expect(lilacSeverity('bhop', false, { ldelta: 143.5 })).toBe('suspected');
    expect(isBigSnap('aimlock', { ldelta: 143.5 })).toBe(false);
  });
});

function freeUdpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    s.on('error', reject);
    s.bind(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });
}
function send(port: number, body: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = dgram.createSocket('udp4');
    const pkt = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x52]), Buffer.from(`L 10/17/2026 - 21:04:13: ${body}\n`, 'utf8')]);
    c.send(pkt, port, '127.0.0.1', (err) => { c.close(); err ? reject(err) : resolve(); });
  });
}
const settle = () => new Promise((r) => setTimeout(r, 80));

describe('L4DL big snap over the wire', () => {
  let app: FastifyInstance | null = null;
  let off: (() => void) | null = null;
  afterEach(async () => { off?.(); off = null; await app?.close(); app = null; });

  it('stores a 143.5 degree aimbot flag as high and says so on the feed event', async () => {
    const events: AdminEvent[] = [];
    off = subscribeAdminEvents((e) => events.push(e));
    const port = await freeUdpPort();
    addServer(db, { name: 'dallas', host: '127.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
    app = await buildServer({ config: { ...loadConfig({}), devMode: false, logListenPort: port }, db });
    await send(port, `L4DL id=${P} cheat=5 banned=0 lflags=4 ldelta=143.5 ltd=200 maxd=143.5 totd=300 taps=3 taps1=1`);
    await send(port, `L4DL id=${P} cheat=5 banned=0 lflags=4 ldelta=12.3 ltd=100 maxd=12.3 totd=40 taps=2 taps1=0`);
    await settle();
    const rows = db.prepare('SELECT kind, severity FROM integrity_flags ORDER BY id').all();
    expect(rows).toEqual([{ kind: 'aimbot', severity: 'high' }, { kind: 'aimbot', severity: 'suspected' }]);
    const lilac = events.filter((e) => e.kind === 'lilac_flag');
    expect(lilac).toEqual([
      { kind: 'lilac_flag', steamid: P, cheat: 'aimbot', banned: false, matchId: null, bigSnap: 143.5 },
      { kind: 'lilac_flag', steamid: P, cheat: 'aimbot', banned: false, matchId: null },
    ]);
  });
});

describe('the big snap on the admin feed', () => {
  let t: FakeTransport;
  let feed: AdminFeedPoster;
  beforeEach(() => {
    setSetting(db, 'discord_admin_channel_id', 'admins');
    t = new FakeTransport();
    feed = new AdminFeedPoster({ db, transport: t, publicUrl: 'https://pug.test' });
    feed.start();
  });
  afterEach(() => feed.stop());

  it('names the snap and does not ping', async () => {
    setSetting(db, 'mod_call_role_id', '123456789012345678');
    publishAdminEvent({ kind: 'lilac_flag', steamid: P, cheat: 'aimbot', banned: false, matchId: 722, bigSnap: 143.5 });
    await feed.idle();
    const [m] = t.live();
    expect(JSON.stringify(m.payload)).toContain('143.5 degree snap');
    expect(JSON.stringify(m.payload)).toContain('/match/722');
    expect(m.payload.content).toBeUndefined();
    expect(m.payload.mentionRoleIds ?? []).toEqual([]);
  });

  it('reads as before without one', async () => {
    publishAdminEvent({ kind: 'lilac_flag', steamid: P, cheat: 'aimbot', banned: false, matchId: null });
    await feed.idle();
    expect(JSON.stringify(t.live()[0].payload)).toContain('Few and rare suspicions are usually false positives');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/aimBigSnap.test.ts`
Expected: FAIL, `Cannot find module '../src/aimRules.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/aimRules.ts`:

```ts
import type { LilacReason } from './logParse.js';
import type { FlagSeverity } from './integrityFlags.js';

/**
 * Aimbot rules from the nepmir ground truth.
 *
 * Design: docs/superpowers/specs/2026-10-17-aimbot-rules-design.md
 *
 * nepmir (dethisa's 5th account) hard-aimbotted match 722 and was banned on
 * 2026-10-17: the first confirmed aimbot. Their moment-to-moment aim looked
 * ordinary at 10 Hz, which fits a "legit" aimbot: it shows in where the
 * bullets land and in rare huge snaps, not in reaction time. Three separators
 * came out of 3,167 player-matches of game logs and 520 of replays:
 *
 *   A. headshot share on SI kills, per weapon group (14 of 16, p = 4e-5);
 *   B. LilAC's aim-snap ldelta (143.5 degrees, every other aimbot flag < 45);
 *   C. a 90+ degree flick onto an SI kill and back within a second (2 in
 *      the match, nobody else more than 1).
 *
 * Evidence for staff, never a verdict: nothing here bans, holds or kicks.
 */

/** Rule B. LilAC's aim-snap `ldelta` at or above this is a big snap. nepmir's
 *  was 143.5; every one of the 42 other aimbot flags on record was under 45. */
export const BIG_SNAP_DEG = 60;

/** The LilAC kind (LILAC_CHEATS in src/integrityFlags.ts) that measures an
 *  aim-snap. aimlock and bhop carry no ldelta of their own. */
const AIMBOT = 'aimbot';

export function isBigSnap(kind: string, reason: LilacReason | undefined): boolean {
  return kind === AIMBOT && reason?.ldelta !== undefined && reason.ldelta >= BIG_SNAP_DEG;
}

/** Rule B, always on (not governed by aim_rules): the severity a LilAC flag
 *  is stored with. A ban LilAC issued itself stays 'banned'. -1 is LilAC's
 *  "unknown" ldelta and is under the line like any small value. */
export function lilacSeverity(kind: string, banned: boolean, reason?: LilacReason): FlagSeverity {
  if (banned) return 'banned';
  return isBigSnap(kind, reason) ? 'high' : 'suspected';
}
```

In `src/integrityFlags.ts`, replace:

```ts
export type FlagSeverity = 'suspected' | 'banned';
```

with:

```ts
/** 'high': a rule calibrated on a confirmed cheater fired (src/aimRules.ts):
 *  LilAC's big snap, or two aim rules in one match. */
export type FlagSeverity = 'suspected' | 'banned' | 'high';
```

In `src/server.ts`, add beside the other module imports (near line 91):

```ts
import { lilacSeverity } from './aimRules.js';
```

and in the `lilac_flag` handler replace the block from `const kind = cheatName(ev.cheat);` through the `publishAdminEvent` call with:

```ts
            const kind = cheatName(ev.cheat);
            // Rule B (src/aimRules.ts): an aimbot flag with a 60+ degree
            // aim-snap is stored high. Always on.
            const severity = lilacSeverity(kind, ev.banned, ev.reason);
            // Stored whether or not the player is in a live match: unlike an
            // input burst, a LilAC flag is worth keeping in warmup or on a
            // spectator, and there is one row per event rather than thousands.
            const stored = recordIntegrityFlag(deps.db, {
              matchId, serverId, steamid: ev.steamid, source: 'lilac',
              kind, severity,
              detail: ev.reason ? lilacReasonDetail(ev.reason) : '',
            });
            if (stored) {
              publishAdminEvent({
                kind: 'lilac_flag', steamid: ev.steamid, cheat: kind,
                banned: ev.banned, matchId,
                ...(severity === 'high' ? { bigSnap: ev.reason!.ldelta! } : {}),
              });
            }
```

In `src/adminFeed.ts`, replace the `lilac_flag` variant with:

```ts
  // Little Anti-Cheat raised a flag on a player. Posted once per player per
  // cheat per match; LilAC fires repeatedly while a cheat looks active.
  // bigSnap: rule B (src/aimRules.ts) marked it high, and this is the snap.
  | { kind: 'lilac_flag'; steamid: string; cheat: string; banned: boolean; matchId: number | null; bigSnap?: number }
```

In `src/discord/adminFeedPoster.ts`, replace `case 'lilac_flag': { ... }` with:

```ts
      case 'lilac_flag': {
        const match = e.matchId ? ` in match [#${e.matchId}](${this.deps.publicUrl}/match/${e.matchId})` : '';
        // Rule B. Stated with the numbers it was calibrated on, and still as
        // something to look at: one confirmed aimbot is one data point.
        if (!e.banned && e.bigSnap !== undefined) {
          return {
            text: `🎯 ${this.name(e.steamid)} tripped Little Anti-Cheat's \`${e.cheat}\` check with a **${e.bigSnap} degree snap**${match}. `
              + `Every honest aimbot flag on record snapped under 45 degrees; the confirmed aimbot snapped 143.5. `
              + `Worth a look at the replay. [File](${this.file(e.steamid)})`,
            color: COLOR.problem,
          };
        }
        // "suspected" is LilAC's own word for the soft case and it is the right
        // one: its docs say few and rare suspicions are likely false positives.
        return {
          text: e.banned
            ? `🛑 ${this.name(e.steamid)} was BANNED by Little Anti-Cheat for \`${e.cheat}\`${match}.`
            : `🎛️ ${this.name(e.steamid)} is suspected by Little Anti-Cheat of \`${e.cheat}\`${match}. Few and rare suspicions are usually false positives.`,
          color: COLOR.problem,
        };
      }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/aimBigSnap.test.ts tests/lilacReason.test.ts tests/lilacFlagParse.test.ts tests/discordAdminFeed.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (`web/src/api.ts` has its own severity union; Task 2 widens it.)

- [ ] **Step 6: Commit**

```bash
git add src/aimRules.ts src/integrityFlags.ts src/server.ts src/adminFeed.ts src/discord/adminFeedPoster.ts tests/aimBigSnap.test.ts
git commit -m "Aim rule B: store a LilAC aimbot flag with a 60+ degree snap as high and name the snap on the feed" -- src/aimRules.ts src/integrityFlags.ts src/server.ts src/adminFeed.ts src/discord/adminFeedPoster.ts tests/aimBigSnap.test.ts
```

---

### Task 2: Rule B on the staff file and the guide

**Files:**
- Modify: `src/admin/timeline/lilac.ts` (the `summary` in `lilacAdapter.items`)
- Modify: `web/src/api.ts:1368` (`IntegrityFlag.severity`)
- Modify: `web/src/routes/admin/file/EvidenceDetail.tsx:179`
- Modify: `web/src/routes/admin/StaffGuide.tsx` (the `aimbot` entry of the `lilac` panel)
- Test: `tests/aimBigSnap.test.ts` (append), `web/src/routes/playerFile.test.tsx` (append)

**Interfaces:**
- Consumes: `BIG_SNAP_DEG` from Task 1; `severity = 'high'` rows from Task 1.
- Produces: nothing new for later tasks.

- [ ] **Step 1: Write the failing tests**

Append to `tests/aimBigSnap.test.ts` (add `import { playerTimeline } from '../src/admin/playerTimeline.js';` to the imports):

```ts
describe('the big snap on the file', () => {
  const STAFF = '76561198000000009';
  const flag = (severity: string, detail: string) => db.prepare(
    `INSERT INTO integrity_flags (match_id, server_id, steamid, source, kind, severity, detail, at)
     VALUES (722, 1, ?, 'lilac', 'aimbot', ?, ?, datetime('now'))`,
  ).run(P, severity, detail);

  it('says big snap, with LilAC\'s reason after it', () => {
    flag('high', 'lflags=4 ldelta=143.5 ltd=200 maxd=143.5 totd=300 taps=3 taps1=1');
    const s = playerTimeline(db, P, STAFF)[0].summary;
    expect(s).toMatch(/^Little Anti-Cheat suspected aimbot with a big snap \(60 degrees or more in one input\)\./);
    expect(s).toMatch(/LilAC's reason: Aim-Snap\./);
    expect(s).not.toMatch(/Few and rare suspicions/);
  });

  it('reads exactly as before for a suspected flag', () => {
    flag('suspected', '');
    expect(playerTimeline(db, P, STAFF)[0].summary).toBe(
      'Little Anti-Cheat suspected aimbot. Few and rare suspicions are usually false positives; a run of them is what matters.',
    );
  });
});
```

Append inside `describe('the evidence detail', ...)` in `web/src/routes/playerFile.test.tsx`:

```tsx
  it('marks a high severity flag as such', async () => {
    mockPeople.file.mockResolvedValue(file({
      sections: {
        ...file().sections,
        evidence: {
          analyzer: null, rounds: [], clips: [], inputFlags: [], inputCaps: [],
          signonDrops: { count: 0, lastAt: null, rows: [] },
          flags: [{ id: 3, matchId: 722, steamid: P, source: 'lilac', kind: 'aimbot', severity: 'high', detail: 'lflags=4 ldelta=143.5', at: '2026-10-17T21:04:13.000Z' }],
        },
      },
    }));
    render(<PlayerFile steamid={P} me="76561199000000009" />);
    await screen.findByRole('heading', { name: /griefer/ });
    expect(screen.getByText(/high severity/)).toBeTruthy();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/aimBigSnap.test.ts web/src/routes/playerFile.test.tsx`
Expected: FAIL. The server test fails on the summary regex; the web test fails to typecheck or find `/high severity/`.

- [ ] **Step 3: Write the implementation**

In `src/admin/timeline/lilac.ts`, add `import { BIG_SNAP_DEG } from '../../aimRules.js';` and replace the `summary:` expression with:

```ts
      summary: (r.severity === 'banned'
        ? `Little Anti-Cheat banned this account on the game server for ${r.kind}.`
        // Rule B (src/aimRules.ts): the one LilAC flag that is not "few and
        // rare", because it was calibrated on the confirmed aimbot.
        : r.severity === 'high'
          ? `Little Anti-Cheat suspected ${r.kind} with a big snap (${BIG_SNAP_DEG} degrees or more in one input). `
            + 'Every honest aimbot flag on record snapped under 45 degrees; the confirmed aimbot snapped 143.5. This one is worth a look on its own.'
          : `Little Anti-Cheat suspected ${r.kind}. Few and rare suspicions are usually false positives; a run of them is what matters.`)
        + reasonSentences(r.kind, r.detail),
```

In `web/src/api.ts`, in `IntegrityFlag` replace `severity: 'suspected' | 'banned';` with:

```ts
  /** 'high': a rule calibrated on a confirmed cheater fired (LilAC's big snap, or two aim rules in one match). */
  severity: 'suspected' | 'banned' | 'high';
```

In `web/src/routes/admin/file/EvidenceDetail.tsx`, replace the severity line inside the flags list with:

```tsx
                {f.severity === 'banned' ? <strong class="admin-warn"> · banned by LilAC</strong>
                  : f.severity === 'high' ? <strong class="admin-warn"> · high severity</strong>
                  : <span class="muted"> · suspected</span>}
```

In `web/src/routes/admin/StaffGuide.tsx`, inside the `aimbot` `<dd>` of the `lilac` panel, after the paragraph ending "is a wheel or rapid-fire pattern, not an aimbot.", add:

```tsx
            {' '}A flag whose single biggest snap (LilAC's own aim-snap reading) was <strong>60 degrees or
            more</strong> is marked <strong>high severity</strong> and called a big snap. Every honest aimbot
            flag on record snapped under 45; the confirmed aimbot (nepmir, match 722) snapped 143.5. Unlike
            the rest of LilAC, one of these is worth opening on its own.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/aimBigSnap.test.ts tests/lilacReason.test.ts web/src/routes/playerFile.test.tsx`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/admin/timeline/lilac.ts web/src/api.ts web/src/routes/admin/file/EvidenceDetail.tsx web/src/routes/admin/StaffGuide.tsx tests/aimBigSnap.test.ts web/src/routes/playerFile.test.tsx
git commit -m "Show LilAC big snaps as high severity on the player file and explain them in the staff guide" -- src/admin/timeline/lilac.ts web/src/api.ts web/src/routes/admin/file/EvidenceDetail.tsx web/src/routes/admin/StaffGuide.tsx tests/aimBigSnap.test.ts web/src/routes/playerFile.test.tsx
```

Tasks 1 and 2 are the "B ships first" unit: everything after this depends on plugin 0.4.0 data.

---

### Task 3: Store SI kills

**Files:**
- Modify: `src/db.ts` (the `SCHEMA` string, after the `input_stalls` block near line 1300)
- Modify: `src/aimRules.ts` (append)
- Modify: `src/mergePlayers.ts:70` (evidence tables)
- Modify: `tests/db.test.ts:41` (table list)
- Test: `tests/siKills.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks but `src/aimRules.ts` itself.
- Produces: table `si_kills` exactly as the spec defines; `interface SiKillInput { matchId: number | null; serverId: number | null; steamid: string; weapon: string; headshot: boolean; dist: number; pre: number; back: number; victimClass: string }`; `recordSiKill(db: DB, k: SiKillInput, now?: Date): number` (returns the row id; `at` is `now.toISOString()`).

- [ ] **Step 1: Write the failing tests**

Create `tests/siKills.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, ensureRating } from '../src/players.js';
import { mergePlayers } from '../src/mergePlayers.js';
import { recordSiKill } from '../src/aimRules.js';

const P = '76561198129925325';
const ALT = '76561199861598482';
let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
  for (const id of [P, ALT]) upsertPlayer(db, { steamid: id, name: `n${id.slice(-2)}`, avatar: null }, []);
  for (const id of [P, ALT]) ensureRating(db, id);
});

describe('recordSiKill', () => {
  it('stores the kill as the spec\'s columns', () => {
    const id = recordSiKill(db, {
      matchId: 722, serverId: 1, steamid: P, weapon: 'smg', headshot: true, dist: 612, pre: 143.5, back: -1, victimClass: 'hunter',
    }, new Date('2026-10-17T21:04:13.000Z'));
    expect(db.prepare('SELECT * FROM si_kills WHERE id = ?').get(id)).toEqual({
      id, match_id: 722, server_id: 1, steamid: P, weapon: 'smg', headshot: 1, dist: 612,
      pre: 143.5, back: -1, victim_class: 'hunter', at: '2026-10-17T21:04:13.000Z',
    });
  });

  it('moves with a merged alt', () => {
    recordSiKill(db, { matchId: 722, serverId: 1, steamid: ALT, weapon: 'smg', headshot: false, dist: 300, pre: 5, back: 2, victimClass: 'smoker' });
    mergePlayers(db, { from: ALT, into: P });
    expect(db.prepare('SELECT steamid FROM si_kills').all()).toEqual([{ steamid: P }]);
  });
});
```

In `tests/db.test.ts`, change the line `'rating_history', ... 'servers', 'settings', 'side_games', 'signon_drops',` so `'si_kills'` sits between `'settings'` and `'side_games'` (SQLite sorts `_` before `d`):

```ts
      'rating_history', 'relay_messages', 'release_boxes', 'releases', 'report_message', 'reporter_chat_pings', 'reports', 'round_metric_context', 'round_metrics', 'rulesets', 'scrim_accepts', 'scrim_blocks', 'scrim_posts', 'scrim_reviews', 'seasons', 'server_chat', 'servers', 'settings', 'si_kills', 'side_games', 'signon_drops',
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/siKills.test.ts tests/db.test.ts`
Expected: FAIL (`recordSiKill` is not exported; no `si_kills` table).

- [ ] **Step 3: Write the implementation**

In `src/db.ts` `SCHEMA`, right after `CREATE INDEX IF NOT EXISTS input_stalls_match ON input_stalls(match_id, steamid);`, add:

```sql

-- SI kills (l4d_inputstats 0.4.0): one row per human survivor's kill of a
-- human SI in a live match, the raw material of the aim rules
-- (src/aimRules.ts). Kept whole so a rule can be recalibrated and re-run
-- over history. pre and back are degrees; back -1 is unknown.
CREATE TABLE IF NOT EXISTS si_kills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id INTEGER, server_id INTEGER, steamid TEXT NOT NULL,
  weapon TEXT NOT NULL, headshot INTEGER NOT NULL, dist INTEGER NOT NULL,
  pre REAL NOT NULL, back REAL NOT NULL, victim_class TEXT NOT NULL, at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS si_kills_match ON si_kills(match_id, steamid);
```

Append to `src/aimRules.ts` (add `import type { DB } from './db.js';` at the top):

```ts
export interface SiKillInput {
  matchId: number | null;
  serverId: number | null;
  steamid: string;
  weapon: string;
  headshot: boolean;
  dist: number;
  pre: number;
  back: number;
  victimClass: string;
}

/** Store one SI kill. Rules A and C read these once the match is over
 *  (scanAimMatches), never per kill: a mid-match prefix is not what they
 *  were calibrated on. */
export function recordSiKill(db: DB, k: SiKillInput, now = new Date()): number {
  const info = db.prepare(
    `INSERT INTO si_kills (match_id, server_id, steamid, weapon, headshot, dist, pre, back, victim_class, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(k.matchId, k.serverId, k.steamid, k.weapon, k.headshot ? 1 : 0, k.dist, k.pre, k.back, k.victimClass, now.toISOString());
  return Number(info.lastInsertRowid);
}
```

In `src/mergePlayers.ts`, after `['input_stalls', 'steamid'],` add:

```ts
  ['si_kills', 'steamid'],
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/siKills.test.ts tests/db.test.ts tests/mergePlayers.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add src/db.ts src/aimRules.ts src/mergePlayers.ts tests/siKills.test.ts tests/db.test.ts
git commit -m "Add the si_kills table the aim rules read, and carry it across a player merge" -- src/db.ts src/aimRules.ts src/mergePlayers.ts tests/siKills.test.ts tests/db.test.ts
```

---

### Task 4: Parse the `k=sikill` line and store it from the wire

**Files:**
- Modify: `src/logParse.ts` (constants near the top, `LogEvent` union near line 273, `degreesOf` after `measureOf`, the `L4DM` branch near line 667)
- Modify: `src/logListener.ts:79` (the token-less admit list)
- Modify: `src/aliases.ts` (`ID_FIELDS`)
- Modify: `src/server.ts` (a `si_kill` handler after the `input_stall` one near line 1034; the aimRules import)
- Test: `tests/siKillParse.test.ts`, `tests/siKills.test.ts` (append)

The parser, the listener gate and the server handler land together: a token-less kind the server handler does not return from would fall through to the token-keyed code below it.

**Interfaces:**
- Consumes: `recordSiKill` (Task 3).
- Produces: `SI_KILL_CLASSES = ['smoker', 'boomer', 'hunter'] as const`, `type SiKillClass`; `LogEvent` variant `{ kind: 'si_kill'; steamid: string; weapon: string; headshot: boolean; dist: number; pre: number; back: number; victimClass: SiKillClass }` (`back` is `-1` for unknown).

- [ ] **Step 1: Write the failing parse tests**

Create `tests/siKillParse.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { parseLogDatagram, type LogEvent } from '../src/logParse.js';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer } from '../src/players.js';
import { addAlias, canonicalise } from '../src/aliases.js';

const A = '76561198129925325';
const parseLogLine = (s: string) => parseLogDatagram(Buffer.from(s, 'utf8'));
const line = (body: string) => `L 10/17/2026 - 21:04:13: ${body}`;
const BODY = `L4DM id=${A} k=sikill w=smg hs=1 dist=612 pre=143.5 back=12.0 cls=hunter v=3`;

describe('the sikill line', () => {
  it('parses what the plugin sends', () => {
    expect(parseLogLine(line(BODY))).toEqual({
      kind: 'si_kill', steamid: A, weapon: 'smg', headshot: true, dist: 612, pre: 143.5, back: 12, victimClass: 'hunter',
    });
  });

  it('reads back=-1 as unknown, in either form the plugin can print', () => {
    expect(parseLogLine(line(BODY.replace('back=12.0', 'back=-1.0')))).toMatchObject({ back: -1 });
    expect(parseLogLine(line(BODY.replace('back=12.0', 'back=-1')))).toMatchObject({ back: -1 });
  });

  it('takes the STEAM_ form a sv_lan box sends', () => {
    expect(parseLogLine(line(BODY.replace(A, 'STEAM_1:1:35074132')))).toMatchObject({ steamid: '76561198030413993' });
  });

  it('reads every class it should and the headshot flag both ways', () => {
    for (const cls of ['smoker', 'boomer', 'hunter']) {
      expect(parseLogLine(line(BODY.replace('cls=hunter', `cls=${cls}`)))).toMatchObject({ victimClass: cls });
    }
    expect(parseLogLine(line(BODY.replace('hs=1', 'hs=0')))).toMatchObject({ headshot: false });
  });

  it('refuses a kill forged through chat', () => {
    expect(parseLogLine(line(`"x<2><STEAM_1:0:5><Survivor>" say "${BODY}"`))).not.toMatchObject({ kind: 'si_kill' });
  });

  it('refuses anything the plugin could not have sent', () => {
    const bad = ['v=2', 'hs=2', 'dist=-1', 'dist=x', 'dist=100001', 'pre=180.5', 'pre=-3', 'back=-2', 'back=181', 'cls=tank', 'cls=witch', 'w=SMG', 'w='];
    for (const b of bad) {
      const key = b.split('=')[0];
      const body = BODY.replace(new RegExp(`${key}=\\S+`), b);
      expect(parseLogLine(line(body)), b).toBeNull();
    }
    expect(parseLogLine(line(BODY.replace(' cls=hunter', '')))).toBeNull();
    expect(parseLogLine(line(BODY.replace(A, 'nope')))).toBeNull();
  });
});

describe('canonicalise covers SI kills', () => {
  let db: DB;
  const ALT = '76561199861598482';
  beforeEach(() => {
    db = openDb(':memory:');
    for (const id of [A, ALT]) upsertPlayer(db, { steamid: id, name: `n${id.slice(-2)}`, avatar: null }, []);
  });

  it('rewrites an alt\'s kill to the canonical account', () => {
    addAlias(db, { steamid: ALT, canonical: A, by: 'admin' });
    const ev: LogEvent = { kind: 'si_kill', steamid: ALT, weapon: 'smg', headshot: true, dist: 600, pre: 10, back: 5, victimClass: 'hunter' };
    expect((canonicalise(db, ev) as { steamid: string }).steamid).toBe(A);
  });
});
```

- [ ] **Step 2: Write the failing wire tests**

Append to `tests/siKills.test.ts` (merge these imports into the file's import block: `afterEach` from vitest, `dgram from 'node:dgram'`, `type AddressInfo from 'node:net'`, `type FastifyInstance from 'fastify'`, `loadConfig from '../src/config.js'`, `buildServer from '../src/server.js'`, `addServer from '../src/serverPool.js'`):

```ts
function freeUdpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    s.on('error', reject);
    s.bind(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });
}
function send(port: number, body: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = dgram.createSocket('udp4');
    const pkt = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x52]), Buffer.from(`L 10/17/2026 - 21:04:13: ${body}\n`, 'utf8')]);
    c.send(pkt, port, '127.0.0.1', (err) => { c.close(); err ? reject(err) : resolve(); });
  });
}
const settle = () => new Promise((r) => setTimeout(r, 80));
const LINE = `L4DM id=${P} k=sikill w=smg hs=1 dist=612 pre=143.5 back=12.0 cls=hunter v=3`;

describe('sikill over the wire', () => {
  let app: FastifyInstance | null = null;
  afterEach(async () => { await app?.close(); app = null; });

  it('stores a kill by a survivor rostered in a live match on that server', async () => {
    const port = await freeUdpPort();
    const sid = addServer(db, { name: 'dallas', host: '127.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
    db.prepare("INSERT INTO matches (id, season_id, state, campaign, server_id) VALUES (722, 1, 'live', 'farm', ?)").run(sid);
    db.prepare("INSERT INTO match_players (match_id, player_id, team) VALUES (722, ?, 'a')").run(P);
    app = await buildServer({ config: { ...loadConfig({}), devMode: false, logListenPort: port }, db });
    await send(port, LINE);
    await settle();
    expect(db.prepare(
      'SELECT match_id AS matchId, server_id AS serverId, weapon, headshot, dist, pre, back, victim_class AS victimClass FROM si_kills',
    ).all()).toEqual([{ matchId: 722, serverId: sid, weapon: 'smg', headshot: 1, dist: 612, pre: 143.5, back: 12, victimClass: 'hunter' }]);
  });

  // Review Focus 1: warmup, a spectator box, a practice lease. Not evidence
  // about a ranked game, and it must never reach a pool.
  it('drops a kill by anyone not rostered in a live match', async () => {
    const port = await freeUdpPort();
    addServer(db, { name: 'dallas', host: '127.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
    app = await buildServer({ config: { ...loadConfig({}), devMode: false, logListenPort: port }, db });
    await send(port, LINE);
    await settle();
    expect(db.prepare('SELECT COUNT(*) AS n FROM si_kills').get()).toEqual({ n: 0 });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/siKillParse.test.ts tests/siKills.test.ts`
Expected: FAIL (the sikill line falls into the burst branch and is refused, so it parses to `null`; no row is stored; `si_kill` is not a `LogEvent` kind).

- [ ] **Step 4: Write the parser**

In `src/logParse.ts`, after the `BOOKING_CMDS` export near the top, add:

```ts
/** The SI an l4d_inputstats 0.4.0 sikill line can name. The tank is not
 *  counted (spec: human SI, not the tank). Anything else refuses the line. */
export const SI_KILL_CLASSES = ['smoker', 'boomer', 'hunter'] as const;
export type SiKillClass = typeof SI_KILL_CLASSES[number];
```

In the `LogEvent` union, after the `input_stall` variant, add:

```ts
  // l4d_inputstats 0.4.0: a human survivor killed a human SI, for the aim
  // rules (src/aimRules.ts). `pre` is the largest view change, in degrees
  // (great-circle, pitch and yaw), between the kill and any view in the 300
  // ms before it; `back` the closest the view came, in the 1000 ms after, to
  // where it was 300 ms before. back -1: unknown (the killer left, died or
  // changed team first), never a return.
  | {
      kind: 'si_kill'; steamid: string; weapon: string; headshot: boolean; dist: number;
      pre: number; back: number; victimClass: SiKillClass;
    }
```

After `measureOf`, add:

```ts
/** A view-angle distance l4d_inputstats measured: 0 to 180 degrees, since a
 *  great-circle angle cannot be more. */
function degreesOf(s: string | undefined): number | null {
  const v = floatOf(s);
  return v !== null && v >= 0 && v <= 180 ? v : null;
}
```

In the `L4DM` branch, directly after the closing brace of the `if (f.k === 'stall') { ... }` block and before `// The budget marker`, add:

```ts
    // An SI kill (plugin 0.4.0). Its own wire version, 3: the stall and
    // burst branches still require 2, and this is a new shape. Every field is
    // a number, a known class or a normalised weapon name; anything else
    // refuses the line.
    if (f.k === 'sikill') {
      const weapon = f.w ?? '';
      const dist = intRange(f.dist, 0, 100_000);
      const pre = degreesOf(f.pre);
      const back = floatOf(f.back) === -1 ? -1 : degreesOf(f.back);
      const cls = f.cls ?? '';
      if (!steamid || f.v !== '3') return null;
      if (!/^[a-z0-9_]{1,32}$/.test(weapon)) return null;
      if (f.hs !== '0' && f.hs !== '1') return null;
      if (dist === null || pre === null || back === null) return null;
      if (!(SI_KILL_CLASSES as readonly string[]).includes(cls)) return null;
      return {
        kind: 'si_kill', steamid, weapon, headshot: f.hs === '1', dist, pre, back, victimClass: cls as SiKillClass,
      };
    }
```

- [ ] **Step 5: Admit, canonicalise and store it**

In `src/logListener.ts`, change the line

```ts
            || ev.kind === 'input_burst' || ev.kind === 'input_cap' || ev.kind === 'input_stall' || ev.kind === 'lilac_flag'
```

to

```ts
            || ev.kind === 'input_burst' || ev.kind === 'input_cap' || ev.kind === 'input_stall' || ev.kind === 'si_kill' || ev.kind === 'lilac_flag'
```

In `src/aliases.ts` `ID_FIELDS`, after `input_stall: ['steamid'],` add:

```ts
  si_kill: ['steamid'],
```

In `src/server.ts`, extend the Task 1 import to `import { lilacSeverity, recordSiKill } from './aimRules.js';` and add, directly after the `input_stall` handler's closing `}`:

```ts
        if (ev.kind === 'si_kill') {
          // The aim rules' raw material (src/aimRules.ts). Same rules as a
          // burst: evidence only, rostered players in a live match only, and
          // never on the critical path.
          try {
            const serverId = serverOf(source, meta);
            const matchId = liveMatchOf(deps.db, serverId, ev.steamid);
            if (matchId === null) return;
            recordSiKill(deps.db, {
              matchId, serverId, steamid: ev.steamid, weapon: ev.weapon, headshot: ev.headshot,
              dist: ev.dist, pre: ev.pre, back: ev.back, victimClass: ev.victimClass,
            });
          } catch (err) {
            console.error('[aim] failed to record an SI kill:', err);
          }
          return;
        }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/siKillParse.test.ts tests/siKills.test.ts tests/inputStalls.test.ts tests/inputBurstParse.test.ts tests/aliases.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add src/logParse.ts src/logListener.ts src/aliases.ts src/server.ts tests/siKillParse.test.ts tests/siKills.test.ts
git commit -m "Parse the l4d_inputstats 0.4.0 sikill line and store kills by rostered survivors in live matches" -- src/logParse.ts src/logListener.ts src/aliases.ts src/server.ts tests/siKillParse.test.ts tests/siKills.test.ts
```

---

### Task 5: Rule A, headshot share

**Files:**
- Modify: `src/aimRules.ts` (append)
- Test: `tests/aimHeadshots.test.ts`

**Interfaces:**
- Consumes: `si_kills` and `recordSiKill` (Task 3).
- Produces:
  - `HS_MIN_KILLS = 10`, `HS_MAX_P = 1e-3`, `HS_POOL_DAYS = 30`, `HS_POOL_MIN = 500`
  - `interface HsGroup { name: 'auto' | 'rifle'; weapons: readonly string[]; fallback: number | null; enabled: boolean }`, `HS_GROUPS: readonly HsGroup[]`
  - `groupOf(weapon: string): HsGroup | null` (strips a leading `weapon_`)
  - `binomialTail(k: number, n: number, p: number): number` (P(X >= k))
  - `interface PooledRate { rate: number; poolKills: number; pooled: boolean }`; `pooledRate(db: DB, group: HsGroup, excludeMatch: number, now?: Date): PooledRate | null`
  - `interface KillRow { id: number; weapon: string; headshot: number; pre: number; back: number; victimClass: string; at: string }`
  - `interface HsResult extends PooledRate { group: string; kills: number; headshots: number; p: number }`; `hsShare(kills: readonly Pick<KillRow, 'weapon' | 'headshot'>[], rateOf: (g: HsGroup) => PooledRate | null): HsResult[]` (only groups that fire)
  - `hsNote(r: HsResult): string`

- [ ] **Step 1: Write the failing tests**

Create `tests/aimHeadshots.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import {
  HS_GROUPS, HS_MAX_P, HS_MIN_KILLS, HS_POOL_MIN, binomialTail, groupOf, hsNote, hsShare, pooledRate, recordSiKill,
} from '../src/aimRules.js';

const A = '76561198129925325';
const AUTO = HS_GROUPS.find((g) => g.name === 'auto')!;
const FIXED = () => ({ rate: 0.367, poolKills: 0, pooled: false });
const kills = (weapon: string, n: number, hs: number) =>
  Array.from({ length: n }, (_, i) => ({ weapon, headshot: i < hs ? 1 : 0 }));

describe('binomialTail', () => {
  it('matches known values', () => {
    expect(binomialTail(14, 16, 0.367)).toBeCloseTo(4.1762e-5, 8);
    expect(binomialTail(3, 10, 0.5)).toBeCloseTo(0.9453125, 12);
    expect(binomialTail(10, 10, 0.5)).toBeCloseTo(1 / 1024, 12);
    expect(binomialTail(9, 10, 0.367)).toBeCloseTo(8.0886e-4, 7);
  });

  it('handles the ends', () => {
    expect(binomialTail(0, 5, 0.3)).toBe(1);
    expect(binomialTail(6, 5, 0.3)).toBe(0);
    expect(binomialTail(1, 5, 0)).toBe(0);
    expect(binomialTail(5, 5, 1)).toBe(1);
  });

  it('does not underflow on a long match', () => {
    const p = binomialTail(150, 200, 0.367);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(1e-20);
  });
});

describe('weapon groups', () => {
  it('pools smg and pistols as auto, the hunting rifle alone, and nothing else', () => {
    expect(groupOf('smg')?.name).toBe('auto');
    expect(groupOf('pistol')?.name).toBe('auto');
    expect(groupOf('dual_pistols')?.name).toBe('auto');
    expect(groupOf('hunting_rifle')?.name).toBe('rifle');
    // Pump kills never report a headshot; the M16 is in no group (plan gap 1).
    for (const w of ['pumpshotgun', 'autoshotgun', 'rifle', 'hunter_claw', '']) expect(groupOf(w), w).toBeNull();
  });

  // Review Focus 5.
  it('reads a weapon_ prefixed name as the same weapon', () => {
    expect(groupOf('weapon_smg')?.name).toBe('auto');
  });

  it('ships the rifle group off until its rate is measured', () => {
    expect(HS_GROUPS.find((g) => g.name === 'rifle')).toMatchObject({ enabled: false, fallback: null });
  });
});

describe('hsShare', () => {
  it('fires on nepmir\'s match', () => {
    const [r] = hsShare(kills('smg', 16, 14), FIXED);
    expect(r).toMatchObject({ group: 'auto', kills: 16, headshots: 14, rate: 0.367, pooled: false });
    expect(r.p).toBeLessThan(HS_MAX_P);
    expect(hsNote(r)).toBe(
      'auto weapons: 14 of 16 SI kills were headshots, p = 4.2e-5 against 0.367 (fixed until 500 kills are on record, 0 so far)',
    );
  });

  it('needs ten kills in the group', () => {
    expect(HS_MIN_KILLS).toBe(10);
    expect(hsShare(kills('smg', 9, 9), FIXED)).toEqual([]);
    expect(hsShare(kills('smg', 10, 9), FIXED)).toHaveLength(1); // p = 8.1e-4
    expect(hsShare(kills('smg', 10, 8), FIXED)).toEqual([]);     // p = 6.7e-3
  });

  it('counts only the group\'s own kills', () => {
    const mixed = [...kills('smg', 9, 9), ...kills('pumpshotgun', 20, 0), ...kills('rifle', 10, 10)];
    expect(hsShare(mixed, FIXED)).toEqual([]);
  });

  it('never fires the disabled rifle group', () => {
    expect(hsShare(kills('hunting_rifle', 30, 30), FIXED)).toEqual([]);
  });

  it('skips a group with no rate', () => {
    expect(hsShare(kills('smg', 16, 16), () => null)).toEqual([]);
  });
});

describe('pooledRate', () => {
  let db: DB;
  const NOW = new Date('2026-10-17T22:00:00.000Z');
  beforeEach(() => { db = openDb(':memory:'); });
  const add = (matchId: number, weapon: string, n: number, hs: number, at = new Date('2026-10-10T20:00:00.000Z')) => {
    for (let i = 0; i < n; i++) {
      recordSiKill(db, { matchId, serverId: 1, steamid: A, weapon, headshot: i < hs, dist: 400, pre: 5, back: 3, victimClass: 'hunter' }, at);
    }
  };

  it('uses the fallback under 500 kills', () => {
    add(1, 'smg', 499, 100);
    expect(pooledRate(db, AUTO, 999, NOW)).toEqual({ rate: 0.367, poolKills: 499, pooled: false });
  });

  it('pools the trailing 30 days once 500 kills exist', () => {
    expect(HS_POOL_MIN).toBe(500);
    add(1, 'smg', 300, 120);
    add(2, 'weapon_pistol', 200, 80);
    add(3, 'smg', 100, 100, new Date('2026-09-01T00:00:00.000Z')); // too old
    add(4, 'pumpshotgun', 100, 0);                                 // other group
    expect(pooledRate(db, AUTO, 999, NOW)).toEqual({ rate: 0.4, poolKills: 500, pooled: true });
  });

  // Review Focus 5: the judged match is never part of its own pool.
  it('leaves the judged match out', () => {
    add(1, 'smg', 500, 200);
    add(722, 'smg', 16, 14);
    expect(pooledRate(db, AUTO, 722, NOW)).toEqual({ rate: 0.4, poolKills: 500, pooled: true });
    expect(pooledRate(db, AUTO, 1, NOW)).toEqual({ rate: 0.367, poolKills: 16, pooled: false });
  });

  it('has no rate for a group with no fallback and too few kills', () => {
    expect(pooledRate(db, HS_GROUPS.find((g) => g.name === 'rifle')!, 999, NOW)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/aimHeadshots.test.ts`
Expected: FAIL (exports missing).

- [ ] **Step 3: Write the implementation**

Append to `src/aimRules.ts`:

```ts
// --- Rule A: headshot share ---------------------------------------------

export const HS_MIN_KILLS = 10;
export const HS_MAX_P = 1e-3;
export const HS_POOL_DAYS = 30;
/** Kills a group needs in the pool before its own rate replaces the fixed one. */
export const HS_POOL_MIN = 500;

export interface HsGroup {
  name: 'auto' | 'rifle';
  weapons: readonly string[];
  /** The rate used until HS_POOL_MIN kills exist, or null for none. */
  fallback: number | null;
  enabled: boolean;
}

/**
 * Survivor kills of human SI, per weapon group. `auto` is the nepmir case,
 * and 0.367 is its pooled share in the log study. Honest snipers headshot a
 * lot, so the hunting rifle is its own pool, off until its rate is measured
 * (the calibration report, src/aimCalibration.ts, prints it). Shotguns are in
 * no group: pump kills never report a headshot. Nor is the M16, whose game
 * name is `rifle` (not this group, which is the hunting rifle).
 */
export const HS_GROUPS: readonly HsGroup[] = [
  { name: 'auto', weapons: ['smg', 'pistol', 'dual_pistols'], fallback: 0.367, enabled: true },
  { name: 'rifle', weapons: ['hunting_rifle'], fallback: null, enabled: false },
];

export function groupOf(weapon: string): HsGroup | null {
  const w = weapon.startsWith('weapon_') ? weapon.slice('weapon_'.length) : weapon;
  return HS_GROUPS.find((g) => g.weapons.includes(w)) ?? null;
}

/** P(X >= k) for X ~ Binomial(n, p), each term built in log space so a long
 *  match cannot underflow or overflow the binomial coefficient. */
export function binomialTail(k: number, n: number, p: number): number {
  if (k <= 0) return 1;
  if (k > n) return 0;
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  const lp = Math.log(p);
  const lq = Math.log1p(-p);
  let logC = 0; // log C(n, i), from i = 0
  let sum = 0;
  for (let i = 0; i <= n; i++) {
    if (i > 0) logC += Math.log(n - i + 1) - Math.log(i);
    if (i >= k) sum += Math.exp(logC + i * lp + (n - i) * lq);
  }
  return Math.min(1, sum);
}

export interface PooledRate { rate: number; poolKills: number; pooled: boolean }

/** The headshot share a group's kills are judged against: every kill in the
 *  trailing HS_POOL_DAYS except the judged match's own (a cheater's kills
 *  would drag the pool toward them), or the fixed rate until the pool has
 *  HS_POOL_MIN kills. Grouped in code, not SQL, so a weapon_ prefixed name
 *  pools with its bare one. */
export function pooledRate(db: DB, group: HsGroup, excludeMatch: number, now = new Date()): PooledRate | null {
  const since = new Date(now.getTime() - HS_POOL_DAYS * 86_400_000).toISOString();
  const rows = db.prepare(
    `SELECT weapon, COUNT(*) AS n, SUM(headshot) AS hs FROM si_kills
     WHERE match_id IS NOT NULL AND match_id <> ? AND at >= ? AND at <= ?
     GROUP BY weapon`,
  ).all(excludeMatch, since, now.toISOString()) as { weapon: string; n: number; hs: number }[];
  let n = 0;
  let hs = 0;
  for (const r of rows) {
    if (groupOf(r.weapon) !== group) continue;
    n += r.n;
    hs += r.hs;
  }
  if (n >= HS_POOL_MIN) return { rate: hs / n, poolKills: n, pooled: true };
  return group.fallback === null ? null : { rate: group.fallback, poolKills: n, pooled: false };
}

/** One si_kills row as the rules read it. */
export interface KillRow { id: number; weapon: string; headshot: number; pre: number; back: number; victimClass: string; at: string }

export interface HsResult extends PooledRate { group: string; kills: number; headshots: number; p: number }

/** Rule A over one player's kills in one match: the groups that fire. */
export function hsShare(
  kills: readonly Pick<KillRow, 'weapon' | 'headshot'>[], rateOf: (g: HsGroup) => PooledRate | null,
): HsResult[] {
  const out: HsResult[] = [];
  for (const g of HS_GROUPS) {
    if (!g.enabled) continue;
    const mine = kills.filter((k) => groupOf(k.weapon) === g);
    if (mine.length < HS_MIN_KILLS) continue;
    const rate = rateOf(g);
    if (!rate) continue;
    const headshots = mine.filter((k) => k.headshot).length;
    const p = binomialTail(headshots, mine.length, rate.rate);
    if (p < HS_MAX_P) out.push({ group: g.name, kills: mine.length, headshots, p, ...rate });
  }
  return out;
}

export function hsNote(r: HsResult): string {
  const pool = r.pooled
    ? `${r.rate.toFixed(3)} pooled from ${r.poolKills} kills over ${HS_POOL_DAYS} days`
    : `${r.rate.toFixed(3)} (fixed until ${HS_POOL_MIN} kills are on record, ${r.poolKills} so far)`;
  return `${r.group} weapons: ${r.headshots} of ${r.kills} SI kills were headshots, p = ${r.p.toExponential(1)} against ${pool}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/aimHeadshots.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`

```bash
git add src/aimRules.ts tests/aimHeadshots.test.ts
git commit -m "Aim rule A: headshot share per weapon group against a pooled rate, with an exact binomial tail" -- src/aimRules.ts tests/aimHeadshots.test.ts
```

---

### Task 6: Rule C, flick and return

**Files:**
- Modify: `src/aimRules.ts` (append)
- Test: `tests/aimFlicks.test.ts`

**Interfaces:**
- Consumes: `KillRow` (Task 5).
- Produces: `FLICK_PRE_DEG = 90`, `FLICK_BACK_DEG = 45`, `FLICK_MIN_KILLS = 2`; `isFlickReturn(k: Pick<KillRow, 'pre' | 'back'>): boolean`; `interface FlickResult { kills: number; flicks: KillRow[] }`; `flickReturns(kills: readonly KillRow[]): FlickResult | null`; `flickNote(r: FlickResult): string`.

- [ ] **Step 1: Write the failing tests**

Create `tests/aimFlicks.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { FLICK_MIN_KILLS, flickNote, flickReturns, isFlickReturn, type KillRow } from '../src/aimRules.js';

const row = (pre: number, back: number, i = 0): KillRow => ({
  id: i + 1, weapon: 'smg', headshot: 1, pre, back, victimClass: i % 2 ? 'smoker' : 'hunter',
  at: `2026-10-17T21:0${i}:13.000Z`,
});

describe('isFlickReturn', () => {
  it('counts 90 out and 45 back, inclusive', () => {
    expect(isFlickReturn(row(90, 45))).toBe(true);
    expect(isFlickReturn(row(143.5, 12))).toBe(true);
    expect(isFlickReturn(row(89.9, 0))).toBe(false);
    expect(isFlickReturn(row(180, 45.1))).toBe(false);
  });

  it('never counts an unknown look back', () => {
    expect(isFlickReturn(row(180, -1))).toBe(false);
  });
});

describe('flickReturns', () => {
  it('needs two in the match', () => {
    expect(FLICK_MIN_KILLS).toBe(2);
    expect(flickReturns([row(143.5, 12, 0), row(10, 3, 1), row(5, 2, 2)])).toBeNull();
    const r = flickReturns([row(143.5, 12, 0), row(10, 3, 1), row(101.5, 30.1, 2)]);
    expect(r?.kills).toBe(3);
    expect(r?.flicks.map((k) => k.id)).toEqual([1, 3]);
  });

  it('does not let back=-1 make up the second', () => {
    expect(flickReturns([row(143.5, 12, 0), row(180, -1, 1)])).toBeNull();
  });

  it('gives the numbers and the times', () => {
    const r = flickReturns([row(143.5, 12, 0), row(10, 3, 1), row(101.5, 30.1, 2)])!;
    expect(flickNote(r)).toBe(
      '2 of 3 SI kills were a 90+ degree flick and back within 45: 21:00:13 hunter (pre 143.5, back 12.0), 21:02:13 hunter (pre 101.5, back 30.1) UTC',
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/aimFlicks.test.ts`
Expected: FAIL (exports missing).

- [ ] **Step 3: Write the implementation**

Append to `src/aimRules.ts`:

```ts
// --- Rule C: flick and return ---------------------------------------------

export const FLICK_PRE_DEG = 90;
export const FLICK_BACK_DEG = 45;
export const FLICK_MIN_KILLS = 2;

/** A kill whose view swung FLICK_PRE_DEG+ in the 300 ms before and came back
 *  within FLICK_BACK_DEG of where it started in the second after. back -1
 *  (the killer left or died first) is unknown and never a return. */
export function isFlickReturn(k: Pick<KillRow, 'pre' | 'back'>): boolean {
  return k.back >= 0 && k.pre >= FLICK_PRE_DEG && k.back <= FLICK_BACK_DEG;
}

export interface FlickResult { kills: number; flicks: KillRow[] }

/** Rule C over one player's kills in one match. nepmir had 2; no honest
 *  player of 520 had more than 1. */
export function flickReturns(kills: readonly KillRow[]): FlickResult | null {
  const flicks = kills.filter(isFlickReturn);
  return flicks.length >= FLICK_MIN_KILLS ? { kills: kills.length, flicks } : null;
}

/** The kills, their degrees and when the site heard of them (UTC; the line
 *  carries no game clock, so this is about a second after the kill). */
export function flickNote(r: FlickResult): string {
  const each = r.flicks.map((k) => `${k.at.slice(11, 19)} ${k.victimClass} (pre ${k.pre.toFixed(1)}, back ${k.back.toFixed(1)})`);
  return `${r.flicks.length} of ${r.kills} SI kills were a ${FLICK_PRE_DEG}+ degree flick and back within ${FLICK_BACK_DEG}: ${each.join(', ')} UTC`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/aimFlicks.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`

```bash
git add src/aimRules.ts tests/aimFlicks.test.ts
git commit -m "Aim rule C: count SI kills that flicked 90+ degrees and came back within 45" -- src/aimRules.ts tests/aimFlicks.test.ts
```

---

### Task 7: The aim_rules setting, escalation and the end-of-match sweep

**Files:**
- Modify: `src/db.ts` (`SCHEMA`: `aim_match_scans` after `si_kills`; `DEFAULT_SETTINGS`: `aim_rules`)
- Modify: `src/settingsSchema.ts` (after `input_pistol_min_rate`)
- Modify: `src/aimRules.ts` (append; imports)
- Modify: `tests/db.test.ts` (table list)
- Test: `tests/aimRules.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 3, 5, 6; `recordIntegrityFlag`, `FlagSeverity` from `src/integrityFlags.ts`; `getSetting` from `src/settings.ts`.
- Produces:
  - `type AimMode = 'off' | 'log' | 'on'`; `aimRulesMode(db: DB): AimMode` (anything unreadable reads as `'log'`)
  - `AIM_SOURCE = 'aim'`; `AIM_KINDS = ['hs_share', 'flick_return', 'aimbot_multi'] as const`; `type AimKind`
  - `interface AimFlag { matchId: number; steamid: string; kind: AimKind; detail: string; post: boolean }`
  - `evaluateAimMatch(db: DB, matchId: number, now?: Date): AimFlag[]` (rows it CREATED; `post` false for a single rule's row when the multi fired)
  - `interface AimPost { matchId: number; steamid: string; kind: AimKind; detail: string }`
  - `scanAimMatches(db: DB, now?: Date, withinMs?: number): AimPost[]` (what to publish; empty unless mode `on`)
  - table `aim_match_scans (match_id INTEGER PRIMARY KEY, at TEXT NOT NULL)`; setting `aim_rules` default `'log'`

- [ ] **Step 1: Write the failing tests**

Create `tests/aimRules.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { getSetting, setSetting } from '../src/settings.js';
import { SETTINGS_SCHEMA, validateSetting } from '../src/settingsSchema.js';
import { recordIntegrityFlag } from '../src/integrityFlags.js';
import { aimRulesMode, evaluateAimMatch, recordSiKill, scanAimMatches } from '../src/aimRules.js';

const A = '76561198129925325';
const B = '76561198000000001';
const NOW = new Date('2026-10-17T22:00:00.000Z');
let db: DB;

beforeEach(() => {
  db = openDb(':memory:');
  db.prepare("INSERT INTO matches (id, season_id, state, campaign, ended_at) VALUES (722, 1, 'completed', 'farm', '2026-10-17 21:48:22')").run();
});

const at = (i: number) => new Date(Date.parse('2026-10-17T21:00:00.000Z') + i * 60_000);
/** 16 smg kills, `hs` of them headshots, `flicks` of them flick-and-return. */
function play(steamid: string, hs: number, flicks: number, matchId = 722): void {
  for (let i = 0; i < 16; i++) {
    const flick = i < flicks;
    recordSiKill(db, {
      matchId, serverId: 1, steamid, weapon: 'smg', headshot: i < hs, dist: 500,
      pre: flick ? 143.5 : 8, back: flick ? 12 : 3, victimClass: 'hunter',
    }, at(i));
  }
}
const bigSnap = (steamid: string, matchId = 722) => recordIntegrityFlag(db, {
  matchId, serverId: 1, steamid, source: 'lilac', kind: 'aimbot', severity: 'high',
  detail: 'lflags=4 ldelta=143.5 ltd=200 maxd=143.5 totd=300 taps=3 taps1=1',
}, at(3));
const aimRows = () => db.prepare(
  "SELECT steamid, match_id AS matchId, kind, severity FROM integrity_flags WHERE source = 'aim' ORDER BY id",
).all();

describe('the aim_rules setting', () => {
  it('ships as log and only takes off, log or on', () => {
    expect(getSetting(db, 'aim_rules')).toBe('log');
    expect(SETTINGS_SCHEMA.some((d) => d.key === 'aim_rules')).toBe(true);
    for (const v of ['off', 'log', 'on']) expect(validateSetting('aim_rules', v).ok, v).toBe(true);
    expect(validateSetting('aim_rules', 'loud').ok).toBe(false);
  });

  it('reads anything unreadable as log', () => {
    setSetting(db, 'aim_rules', '');
    expect(aimRulesMode(db)).toBe('log');
    setSetting(db, 'aim_rules', 'on');
    expect(aimRulesMode(db)).toBe('on');
  });
});

describe('evaluateAimMatch', () => {
  it('writes one rule alone as its own flag, posted', () => {
    play(A, 14, 0);
    const out = evaluateAimMatch(db, 722, NOW);
    expect(out.map((f) => [f.kind, f.post])).toEqual([['hs_share', true]]);
    expect(aimRows()).toEqual([{ steamid: A, matchId: 722, kind: 'hs_share', severity: 'suspected' }]);
  });

  it('escalates nepmir\'s match: A and C make one high aimbot_multi, and only it posts', () => {
    play(A, 14, 2);
    const out = evaluateAimMatch(db, 722, NOW);
    expect(out.map((f) => [f.kind, f.post])).toEqual([['hs_share', false], ['flick_return', false], ['aimbot_multi', true]]);
    expect(aimRows()).toEqual([
      { steamid: A, matchId: 722, kind: 'hs_share', severity: 'suspected' },
      { steamid: A, matchId: 722, kind: 'flick_return', severity: 'suspected' },
      { steamid: A, matchId: 722, kind: 'aimbot_multi', severity: 'high' },
    ]);
    expect(out[2].detail).toMatch(/^hs_share \+ flick_return\. hs_share: auto weapons: 14 of 16/);
  });

  it('counts B from the LilAC row in the same match', () => {
    play(A, 14, 0);
    bigSnap(A);
    const multi = evaluateAimMatch(db, 722, NOW).find((f) => f.kind === 'aimbot_multi');
    expect(multi?.detail).toMatch(/^hs_share \+ big_snap\./);
    expect(multi?.detail).toMatch(/big_snap: LilAC aim-snap 143\.5 degrees/);
  });

  it('does not count B from another match or another player', () => {
    db.prepare("INSERT INTO matches (id, season_id, state, campaign, ended_at) VALUES (700, 1, 'completed', 'farm', '2026-10-16 21:00:00')").run();
    play(A, 14, 0);
    bigSnap(A, 700);
    bigSnap(B);
    expect(evaluateAimMatch(db, 722, NOW).map((f) => f.kind)).toEqual(['hs_share']);
  });

  it('writes nothing for an honest match', () => {
    play(B, 6, 1);
    expect(evaluateAimMatch(db, 722, NOW)).toEqual([]);
    expect(aimRows()).toEqual([]);
  });

  it('never writes a row twice', () => {
    play(A, 14, 2);
    evaluateAimMatch(db, 722, NOW);
    expect(evaluateAimMatch(db, 722, NOW)).toEqual([]);
    expect(aimRows()).toHaveLength(3);
  });
});

describe('scanAimMatches', () => {
  it('posts nothing in log mode but keeps the rows', () => {
    play(A, 14, 2);
    expect(scanAimMatches(db, NOW)).toEqual([]);
    expect(aimRows()).toHaveLength(3);
  });

  it('posts what fired in on mode, once per match', () => {
    setSetting(db, 'aim_rules', 'on');
    play(A, 14, 2);
    play(B, 14, 0);
    const posts = scanAimMatches(db, NOW);
    expect(posts.map((p) => [p.steamid, p.kind])).toEqual([[A, 'aimbot_multi'], [B, 'hs_share']]);
    // Review Focus 2: the next sweep, or the first after a restart.
    expect(scanAimMatches(db, NOW)).toEqual([]);
    expect(aimRows()).toHaveLength(4);
  });

  // Review Focus 3.
  it('does not post the log week when the setting goes on', () => {
    play(A, 14, 2);
    scanAimMatches(db, NOW);
    setSetting(db, 'aim_rules', 'on');
    expect(scanAimMatches(db, NOW)).toEqual([]);
  });

  it('writes nothing when off, and still settles the match', () => {
    setSetting(db, 'aim_rules', 'off');
    play(A, 14, 2);
    expect(scanAimMatches(db, NOW)).toEqual([]);
    expect(aimRows()).toEqual([]);
    expect(db.prepare('SELECT match_id FROM aim_match_scans').all()).toEqual([{ match_id: 722 }]);
  });

  it('waits for the match to end and ignores old ones', () => {
    setSetting(db, 'aim_rules', 'on');
    db.prepare("INSERT INTO matches (id, season_id, state, campaign) VALUES (723, 1, 'live', 'farm')").run();
    db.prepare("INSERT INTO matches (id, season_id, state, campaign, ended_at) VALUES (600, 1, 'completed', 'farm', '2026-10-10 21:00:00')").run();
    play(A, 14, 2, 723);
    play(B, 14, 2, 600);
    expect(scanAimMatches(db, NOW)).toEqual([]);
    expect(aimRows()).toEqual([]);
  });

  it('judges an aborted match too', () => {
    setSetting(db, 'aim_rules', 'on');
    db.prepare("UPDATE matches SET state = 'aborted' WHERE id = 722").run();
    play(A, 14, 0);
    expect(scanAimMatches(db, NOW).map((p) => p.kind)).toEqual(['hs_share']);
  });
});
```

In `tests/db.test.ts`, change `'admin_actions',` (the first entry of the table list) to:

```ts
      'admin_actions', 'aim_match_scans',
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/aimRules.test.ts tests/db.test.ts`
Expected: FAIL (missing setting, table and exports).

- [ ] **Step 3: Write the implementation**

In `src/db.ts` `SCHEMA`, after `CREATE INDEX IF NOT EXISTS si_kills_match ...;`, add:

```sql

-- Ended matches the aim rules have been run over, once (scanAimMatches in
-- src/aimRules.ts). Claimed even with the rules off, so turning them on
-- later never posts history.
CREATE TABLE IF NOT EXISTS aim_match_scans (
  match_id INTEGER PRIMARY KEY,
  at TEXT NOT NULL
);
```

In `DEFAULT_SETTINGS`, after `input_pistol_min_rate: '12',` add:

```ts
  // The aim rules A and C and their escalation (src/aimRules.ts): off, log
  // (flags on the file, nothing posted) or on. log until the thresholds are
  // re-measured on plugin data. Rule B (LilAC's big snap) is always on.
  aim_rules: 'log',
```

In `src/settingsSchema.ts`, after the `input_pistol_min_rate` entry, add:

```ts
  { key: 'aim_rules', group: 'Stats', label: 'Aim rules', help: 'The headshot share and flick-and-return aim rules, and the aimbot_multi flag when two aim rules (or one and a LilAC big snap) fire in one match. Log only writes the flags to the player file and posts nothing, which is how they ship until a week of plugin data re-measures the thresholds. On posts them to the mod channel, and aimbot_multi pings the mod call role. Evidence for review only: nothing happens in game. LilAC big snaps are always on and not affected.', type: { kind: 'choice', options: [{ value: 'off', label: 'Off' }, { value: 'log', label: 'Log only (file, no posts)' }, { value: 'on', label: 'On (posted to the mod channel)' }] } },
```

In `src/aimRules.ts`, change the imports at the top to:

```ts
import type { DB } from './db.js';
import type { LilacReason } from './logParse.js';
import { recordIntegrityFlag, type FlagSeverity } from './integrityFlags.js';
import { getSetting } from './settings.js';
```

and append:

```ts
// --- Mode, escalation and the sweep -------------------------------------

export type AimMode = 'off' | 'log' | 'on';

/** aim_rules, read fresh each sweep. Anything unreadable is log: it records
 *  without posting, the safe middle. Rule B does not read this. */
export function aimRulesMode(db: DB): AimMode {
  const v = getSetting(db, 'aim_rules');
  return v === 'off' || v === 'on' ? v : 'log';
}

/** integrity_flags.source for A, C and escalation. Not 'analyzer': the
 *  analyzer's timeline adapter reads every one of those as newcomer_esp. */
export const AIM_SOURCE = 'aim';
/** Read by name by the evader fingerprints plan's "cheat flag" sign. */
export const AIM_KINDS = ['hs_share', 'flick_return', 'aimbot_multi'] as const;
export type AimKind = typeof AIM_KINDS[number];

export interface AimFlag {
  matchId: number;
  steamid: string;
  kind: AimKind;
  detail: string;
  /** False for a single rule's row when aimbot_multi fired: the multi is the post. */
  post: boolean;
}

export interface AimPost { matchId: number; steamid: string; kind: AimKind; detail: string }

/** Rule B's biggest snap for this player in this match, from the LilAC rows
 *  Task 1 stored high, or null. */
function bigSnapIn(db: DB, matchId: number, steamid: string): number | null {
  const rows = db.prepare(
    "SELECT detail FROM integrity_flags WHERE source = 'lilac' AND severity = 'high' AND match_id = ? AND steamid = ?",
  ).all(matchId, steamid) as { detail: string }[];
  let best: number | null = null;
  for (const r of rows) {
    const m = /(?:^| )ldelta=(\d+(?:\.\d+)?)/.exec(r.detail);
    if (m && (best === null || Number(m[1]) > best)) best = Number(m[1]);
  }
  return best;
}

/** One row per player, match and kind, ever. */
function storeAim(
  db: DB, matchId: number, serverId: number | null, steamid: string, kind: AimKind, severity: FlagSeverity, detail: string, now: Date,
): boolean {
  const has = db.prepare(
    'SELECT 1 FROM integrity_flags WHERE steamid = ? AND match_id = ? AND source = ? AND kind = ?',
  ).get(steamid, matchId, AIM_SOURCE, kind);
  if (has) return false;
  return recordIntegrityFlag(db, { matchId, serverId, steamid, source: AIM_SOURCE, kind, severity, detail }, now) !== null;
}

/**
 * Rules A and C over one ended match, then escalation with B. Every rule
 * that fires keeps its own row (so each is on the file and readable by
 * name); when two or more of A/B/C fire for one player, one aimbot_multi row
 * at severity high is added and is the only one to post. Returns the rows
 * this call created.
 */
export function evaluateAimMatch(db: DB, matchId: number, now = new Date()): AimFlag[] {
  const players = db.prepare(
    'SELECT steamid, MIN(server_id) AS serverId FROM si_kills WHERE match_id = ? GROUP BY steamid ORDER BY MIN(id)',
  ).all(matchId) as { steamid: string; serverId: number | null }[];
  const out: AimFlag[] = [];
  for (const { steamid, serverId } of players) {
    const kills = db.prepare(
      `SELECT id, weapon, headshot, pre, back, victim_class AS victimClass, at
       FROM si_kills WHERE match_id = ? AND steamid = ? ORDER BY id`,
    ).all(matchId, steamid) as KillRow[];
    const hs = hsShare(kills, (g) => pooledRate(db, g, matchId, now));
    const flick = flickReturns(kills);
    const snap = bigSnapIn(db, matchId, steamid);

    const parts: { rule: string; detail: string }[] = [];
    if (hs.length > 0) parts.push({ rule: 'hs_share', detail: hs.map(hsNote).join('; ') });
    if (flick) parts.push({ rule: 'flick_return', detail: flickNote(flick) });
    if (snap !== null) parts.push({ rule: 'big_snap', detail: `LilAC aim-snap ${snap} degrees` });
    const multi = parts.length >= 2;

    for (const p of parts) {
      // B's row is LilAC's own, stored and posted live by src/server.ts.
      if (p.rule === 'big_snap') continue;
      const kind = p.rule as AimKind;
      if (storeAim(db, matchId, serverId, steamid, kind, 'suspected', p.detail, now)) {
        out.push({ matchId, steamid, kind, detail: p.detail, post: !multi });
      }
    }
    if (multi) {
      const detail = `${parts.map((p) => p.rule).join(' + ')}. ${parts.map((p) => `${p.rule}: ${p.detail}`).join('. ')}`;
      if (storeAim(db, matchId, serverId, steamid, 'aimbot_multi', 'high', detail, now)) {
        out.push({ matchId, steamid, kind: 'aimbot_multi', detail, post: true });
      }
    }
  }
  return out;
}

/**
 * The aim rules, once per match after it ends, from the server's one-minute
 * sweep (beside scanEndedMatches): whole matches only, the way the rules
 * were calibrated. Each match is claimed in the same transaction that judges
 * it, so a second sweep cannot announce the same row, and is claimed even
 * with the rules off or the post suppressed, so switching to on never posts
 * history. Only matches that ended inside `withinMs` are looked at.
 * Returns what to publish: nothing unless aim_rules is on.
 */
export function scanAimMatches(db: DB, now = new Date(), withinMs = 6 * 3_600_000): AimPost[] {
  const mode = aimRulesMode(db);
  const since = new Date(now.getTime() - withinMs).toISOString().replace('T', ' ').slice(0, 19);
  const matches = db.prepare(
    `SELECT id FROM matches
     WHERE state IN ('completed', 'aborted') AND COALESCE(ended_at, created_at) >= ?
       AND NOT EXISTS (SELECT 1 FROM aim_match_scans s WHERE s.match_id = matches.id)
     ORDER BY id`,
  ).all(since) as { id: number }[];
  const claim = db.prepare('INSERT OR IGNORE INTO aim_match_scans (match_id, at) VALUES (?, ?)');
  const out: AimPost[] = [];
  for (const { id } of matches) {
    db.transaction(() => {
      if (claim.run(id, now.toISOString()).changes === 0) return;
      if (mode === 'off') return;
      for (const f of evaluateAimMatch(db, id, now)) {
        if (mode === 'on' && f.post) out.push({ matchId: f.matchId, steamid: f.steamid, kind: f.kind, detail: f.detail });
      }
    })();
  }
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/aimRules.test.ts tests/db.test.ts tests/adminSettings.test.ts tests/aimHeadshots.test.ts tests/aimFlicks.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`

```bash
git add src/db.ts src/settingsSchema.ts src/aimRules.ts tests/aimRules.test.ts tests/db.test.ts
git commit -m "Run aim rules A and C once per ended match, escalate two rules to a high aimbot_multi flag, behind the aim_rules setting" -- src/db.ts src/settingsSchema.ts src/aimRules.ts tests/aimRules.test.ts tests/db.test.ts
```

---

### Task 8: Post aim flags to the mod channel

**Files:**
- Modify: `src/adminFeed.ts` (`AdminEvent`, `FEED_SETTING`)
- Modify: `src/discord/feedRouting.ts` (`FEED_DESTINATION`)
- Modify: `src/discord/adminFeedPoster.ts` (a `case 'aim_flag'` after `newcomer_flag`)
- Modify: `src/server.ts` (the reaper, after the `scanEndedMatches` block near line 1696; import)
- Test: `tests/aimFeed.test.ts`

**Interfaces:**
- Consumes: `scanAimMatches`, `AimPost` (Task 7).
- Produces: `AdminEvent` variant `{ kind: 'aim_flag'; steamid: string; matchId: number; rule: 'hs_share' | 'flick_return' | 'aimbot_multi'; detail: string }`, routed to the mod channel, setting `admin_feed_problems`, `ping: true` only for `aimbot_multi`.

- [ ] **Step 1: Write the failing tests**

Create `tests/aimFeed.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { publishAdminEvent } from '../src/adminFeed.js';
import { destinationOf } from '../src/discord/feedRouting.js';
import { AdminFeedPoster } from '../src/discord/adminFeedPoster.js';
import { FakeTransport } from './fakes/fakeTransport.js';

const P = '76561198129925325';
const ROLE = '123456789012345678';
let db: DB;
let t: FakeTransport;
let feed: AdminFeedPoster;

beforeEach(() => {
  db = openDb(':memory:');
  upsertPlayer(db, { steamid: P, name: 'nepmir', avatar: null }, []);
  setSetting(db, 'discord_admin_channel_id', 'admins');
  setSetting(db, 'discord_mod_channel_id', 'mods');
  setSetting(db, 'mod_call_role_id', ROLE);
  t = new FakeTransport();
  feed = new AdminFeedPoster({ db, transport: t, publicUrl: 'https://pug.test' });
  feed.start();
});
afterEach(() => feed.stop());

describe('aim flags on the feed', () => {
  it('go to the mod channel', () => {
    expect(destinationOf({ kind: 'aim_flag', steamid: P, matchId: 722, rule: 'hs_share', detail: '' })).toBe('mod');
  });

  it('ping the mod call role for aimbot_multi', async () => {
    publishAdminEvent({ kind: 'aim_flag', steamid: P, matchId: 722, rule: 'aimbot_multi', detail: 'hs_share + flick_return. hs_share: ...' });
    await feed.idle();
    const [m] = t.live();
    expect(m.channelId).toBe('mods');
    expect(m.payload.content).toBe(`<@&${ROLE}>`);
    expect(m.payload.mentionRoleIds).toEqual([ROLE]);
    expect(JSON.stringify(m.payload)).toContain('two or more aim rules');
    expect(JSON.stringify(m.payload)).toContain('/match/722');
    expect(JSON.stringify(m.payload)).toContain('Nothing was done to the account');
  });

  it('do not ping for one rule alone', async () => {
    publishAdminEvent({ kind: 'aim_flag', steamid: P, matchId: 722, rule: 'flick_return', detail: '2 of 9 SI kills were a 90+ degree flick' });
    await feed.idle();
    const [m] = t.live();
    expect(m.channelId).toBe('mods');
    expect(m.payload.content).toBeUndefined();
    expect(JSON.stringify(m.payload)).toContain('`flick_return` aim rule');
  });

  it('go quiet with the problems feed switched off', async () => {
    setSetting(db, 'admin_feed_problems', '0');
    publishAdminEvent({ kind: 'aim_flag', steamid: P, matchId: 722, rule: 'aimbot_multi', detail: '' });
    await feed.idle();
    expect(t.live()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/aimFeed.test.ts`
Expected: FAIL (type error: unknown kind `aim_flag`).

- [ ] **Step 3: Write the implementation**

In `src/adminFeed.ts`, after the `newcomer_flag` variant, add:

```ts
  /** An aim rule fired on a whole ended match (src/aimRules.ts). Only with
   *  aim_rules on. aimbot_multi (two or more rules, or one and a LilAC big
   *  snap) pings the mod call role; a single rule does not. */
  | { kind: 'aim_flag'; steamid: string; matchId: number; rule: 'hs_share' | 'flick_return' | 'aimbot_multi'; detail: string }
```

and in `FEED_SETTING`, after `newcomer_flag: 'admin_feed_problems',`:

```ts
  aim_flag: 'admin_feed_problems',
```

In `src/discord/feedRouting.ts` `FEED_DESTINATION`, after `newcomer_flag: 'mod',`:

```ts
  // Rare, calibrated on a confirmed cheater, and a moderator acts on it.
  aim_flag: 'mod',
```

In `src/discord/adminFeedPoster.ts`, after the `newcomer_flag` case, add:

```ts
      case 'aim_flag': {
        const match = `match [#${e.matchId}](${this.deps.publicUrl}/match/${e.matchId})`;
        // Loud only for the combination: one rule alone is calibrated on one
        // cheater and is something to watch, not something to drop
        // everything for.
        if (e.rule === 'aimbot_multi') {
          return {
            text: `🚨 **Aim rules:** ${this.name(e.steamid)} tripped two or more aim rules in ${match} (${e.detail}). `
              + `Nothing was done to the account. Watch the replay before deciding anything. [File](${this.file(e.steamid)})`,
            color: COLOR.problem,
            ping: true,
          };
        }
        const what = e.rule === 'hs_share' ? 'headshot share' : 'flick and return';
        return {
          text: `🎯 ${this.name(e.steamid)} tripped the \`${e.rule}\` aim rule (${what}) in ${match} (${e.detail}). `
            + `Evidence to weigh against the replay, not a verdict. [File](${this.file(e.steamid)})`,
          color: COLOR.problem,
        };
      }
```

In `src/server.ts`, extend the aimRules import to `import { lilacSeverity, recordSiKill, scanAimMatches } from './aimRules.js';` and in the reaper, directly after the `try { ... } catch (err) { console.error('[inputstats] end-of-match scan failed:', err); }` block, add:

```ts
    try {
      // The aim rules judge whole matches, once each ends (src/aimRules.ts).
      // Empty unless aim_rules is on; log mode still writes the rows.
      for (const f of scanAimMatches(deps.db)) {
        publishAdminEvent({ kind: 'aim_flag', steamid: f.steamid, matchId: f.matchId, rule: f.kind, detail: f.detail });
      }
    } catch (err) {
      console.error('[aim] end-of-match scan failed:', err);
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/aimFeed.test.ts tests/feedRouting.test.ts tests/discordAdminFeed.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`

```bash
git add src/adminFeed.ts src/discord/feedRouting.ts src/discord/adminFeedPoster.ts src/server.ts tests/aimFeed.test.ts
git commit -m "Post aim rule flags to the mod channel from the one-minute sweep, pinging the mod role for aimbot_multi" -- src/adminFeed.ts src/discord/feedRouting.ts src/discord/adminFeedPoster.ts src/server.ts tests/aimFeed.test.ts
```

---

### Task 9: Aim rules on the player file, Needs a look and the staff guide

**Files:**
- Create: `src/admin/timeline/aim.ts`
- Modify: `src/admin/timeline/types.ts` (`TimelineSource`, `EvidenceSource`, `isEvidence`)
- Modify: `src/admin/playerTimeline.ts` (`ADAPTERS`)
- Modify: `src/admin/arrived.ts` (after the LilAC part)
- Modify: `web/src/api.ts:1525` (`TimelineSource`)
- Modify: `web/src/routes/admin/file/GlanceRow.tsx` (`SOURCE_LABEL`)
- Modify: `web/src/routes/admin/StaffGuide.tsx` (index entry and a new `aim` panel after `lilac`)
- Test: `tests/aimTimeline.test.ts`

**Interfaces:**
- Consumes: `AIM_SOURCE`, `aimRulesMode` (Task 7); rows with `source = 'aim'`.
- Produces: `aimAdapter: TimelineAdapter` with `source: 'aim'`; `'aim'` in both server and web `TimelineSource`.

- [ ] **Step 1: Write the failing tests**

Create `tests/aimTimeline.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { playerTimeline } from '../src/admin/playerTimeline.js';
import { needsALook } from '../src/admin/needsALook.js';
import { fileViewer } from '../src/admin/fileAccess.js';
import { arrivedSince } from '../src/admin/arrived.js';
import { isEvidence } from '../src/admin/timeline/types.js';

const P = '76561198129925325';
const STAFF = '76561198000000009';
let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
  upsertPlayer(db, { steamid: P, name: 'nepmir', avatar: null }, []);
  upsertPlayer(db, { steamid: STAFF, name: 'boss', avatar: null }, []);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(STAFF);
  db.prepare(
    `INSERT INTO integrity_flags (match_id, server_id, steamid, source, kind, severity, detail, at)
     VALUES (722, 1, ?, 'aim', 'aimbot_multi', 'high', 'hs_share + flick_return. hs_share: auto weapons: 14 of 16', '2026-10-17T21:50:00.000Z')`,
  ).run(P);
});

describe('aim flags on the file', () => {
  it('read as the rule, with the numbers', () => {
    const [item] = playerTimeline(db, P, STAFF).filter((i) => i.source === 'aim');
    expect(item).toMatchObject({ source: 'aim', kind: 'aimbot_multi', matchId: 722, ref: { type: 'integrity_flag' } });
    expect(item.summary).toMatch(/^Two or more aim rules fired in one match \(hs_share \+ flick_return\./);
  });

  it('are on file but not evidence while the rules are in log mode', () => {
    const [item] = playerTimeline(db, P, STAFF).filter((i) => i.source === 'aim');
    expect(item.allowed).toBe(true);
    expect(isEvidence(item)).toBe(false);
    expect(needsALook(db, fileViewer(db, STAFF)).some((r) => r.steamid === P)).toBe(false);
  });

  it('count once the rules are on', () => {
    setSetting(db, 'aim_rules', 'on');
    const items = playerTimeline(db, P, STAFF);
    const [item] = items.filter((i) => i.source === 'aim');
    expect(isEvidence(item)).toBe(true);
    expect(needsALook(db, fileViewer(db, STAFF)).some((r) => r.steamid === P)).toBe(true);
    expect(arrivedSince(items, null)).toContain('aim rules: aimbot_multi');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/aimTimeline.test.ts`
Expected: FAIL (no `aim` items).

- [ ] **Step 3: Write the implementation**

Create `src/admin/timeline/aim.ts`:

```ts
import type { DB } from '../../db.js';
import { AIM_SOURCE, aimRulesMode } from '../../aimRules.js';
import { ROW_LIMIT, marks, toIso, type TimelineAdapter, type TimelineItem } from './types.js';

interface Row { id: number; match_id: number | null; kind: string; detail: string; at: string }

/** What each aim rule means, in the words an admin reads. An unknown kind
 *  (a future rule) shows as itself rather than disappearing. */
const RULE_TEXT: Record<string, string> = {
  hs_share: 'Aim rule hs_share: far more headshots on infected than the pool',
  flick_return: 'Aim rule flick_return: turned 90+ degrees onto an infected for the kill and straight back',
  aimbot_multi: 'Two or more aim rules fired in one match',
};

/**
 * The aim rules' flags (src/aimRules.ts): whole matches, judged after they
 * ended, from the plugin's SI kill lines and LilAC's big snaps.
 *
 * While aim_rules is not on, the thresholds are still being re-measured, so
 * a flag is on the file for the record and never puts it in the queue: the
 * same treatment as an uncalibrated analyzer clip.
 */
export const aimAdapter: TimelineAdapter = {
  source: 'aim',
  items({ db, ids }): TimelineItem[] {
    const calibrated = aimRulesMode(db) === 'on';
    const rows = db.prepare(
      `SELECT id, match_id, kind, detail, at FROM integrity_flags
       WHERE source = ? AND steamid IN (${marks(ids)})
       ORDER BY at DESC, id DESC LIMIT ?`,
    ).all(AIM_SOURCE, ...ids, ROW_LIMIT) as Row[];
    return rows.map((r) => ({
      at: toIso(r.at),
      source: 'aim' as const,
      kind: r.kind,
      summary: `${RULE_TEXT[r.kind] ?? r.kind} (${r.detail}). Evidence, not a verdict: watch the replay before deciding anything.`,
      matchId: r.match_id,
      replay: null,
      ref: { type: 'integrity_flag', id: r.id },
      ...(calibrated ? {} : { allowed: true as const }),
    }));
  },
  evidence(db: DB) {
    if (aimRulesMode(db) !== 'on') return [];
    return db.prepare(
      'SELECT steamid, MAX(at) AS at FROM integrity_flags WHERE source = ? GROUP BY steamid',
    ).all(AIM_SOURCE) as { steamid: string; at: string }[];
  },
};
```

In `src/admin/timeline/types.ts`, add `'aim'` to both unions:

```ts
export type TimelineSource =
  | 'input' | 'lilac' | 'analyzer' | 'drop' | 'ticket' | 'penalty' | 'ban'
  | 'note' | 'steam' | 'discord_link' | 'cvar' | 'conduct' | 'spray' | 'aim';
```

```ts
export type EvidenceSource = 'input' | 'lilac' | 'analyzer' | 'drop' | 'steam' | 'cvar' | 'conduct' | 'spray' | 'aim';
```

and in `isEvidence` change the last line of the return to:

```ts
    || item.source === 'spray' || item.source === 'aim';
```

In `src/admin/playerTimeline.ts`, add `import { aimAdapter } from './timeline/aim.js';` and put `aimAdapter,` after `lilacAdapter,` in `ADAPTERS`.

In `src/admin/arrived.ts`, after the `lilac` block, add:

```ts
  const aim = by('aim');
  if (aim.length > 0) parts.push(`aim rules: ${[...new Set(aim.map((i) => i.kind))].sort().join(', ')}`);
```

In `web/src/api.ts`, change `TimelineSource` to end `| 'note' | 'steam' | 'discord_link' | 'cvar' | 'conduct' | 'spray' | 'aim';`.

In `web/src/routes/admin/file/GlanceRow.tsx` `SOURCE_LABEL`, after `spray: 'Crash spray',` add `aim: 'Aim rules',`.

In `web/src/routes/admin/StaffGuide.tsx`, add `<li><a href="#aim">Aim rules</a></li>` after the `lilac` index entry, and after the closing `</Panel>` of the `lilac` panel add:

```tsx
      <Panel id="aim">
        <h3>Aim rules</h3>
        <p>
          Shown as <code>aim rules: hs_share, aimbot_multi</code>. Three rules learned from the first
          confirmed aimbot (nepmir, match 722). They judge a whole match once it ends, never a moment, and
          they never ban or kick anyone.
        </p>
        <dl class="howto-cmds">
          <dt><code>hs_share</code></dt>
          <dd>
            Ten or more kills of human infected with the SMG or pistols in one match, with a headshot share
            so far above everyone else's that the odds of it by chance are under 1 in 1000. The file gives the
            kills, the headshots, the odds and the rate it was compared with. nepmir: 14 of 16.
          </dd>
          <dt><code>flick_return</code></dt>
          <dd>
            Two or more infected kills in one match where the view swung 90 degrees or more onto the kill in
            the 0.3 s before it, then came back within 45 degrees of where it started in the second after.
            nepmir did it twice; nobody else on record more than once.
          </dd>
          <dt><code>aimbot_multi</code></dt>
          <dd>
            Two of the three (the two above, or one of them plus a Little Anti-Cheat big snap) in the same
            match. High severity, and it pings the mod role. Still evidence: watch the replay.
          </dd>
        </dl>
        <p>
          While the rules are in log mode (Settings, Aim rules) these sit on the file without putting it in
          Needs a look, because the thresholds are being re-measured.
        </p>
      </Panel>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/aimTimeline.test.ts tests/lilacReason.test.ts tests/integrityNewcomer.test.ts web/src/routes/playerFile.test.tsx`
Then: `npm test`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`

```bash
git add src/admin/timeline/aim.ts src/admin/timeline/types.ts src/admin/playerTimeline.ts src/admin/arrived.ts web/src/api.ts web/src/routes/admin/file/GlanceRow.tsx web/src/routes/admin/StaffGuide.tsx tests/aimTimeline.test.ts
git commit -m "Show aim rule flags on the player file and in Needs a look once the rules are on, and explain them in the staff guide" -- src/admin/timeline/aim.ts src/admin/timeline/types.ts src/admin/playerTimeline.ts src/admin/arrived.ts web/src/api.ts web/src/routes/admin/file/GlanceRow.tsx web/src/routes/admin/StaffGuide.tsx tests/aimTimeline.test.ts
```

---

### Task 10: l4d_inputstats 0.4.0, the angle ring and the sikill line

**Files:**
- Modify: `plugin/l4d_inputstats.sp`
- Create: `plugin/build-inputstats.sh`
- Test: `tests/siKillParse.test.ts` (append the format-pinned line)

**Interfaces:**
- Consumes: the wire line the site parses (Task 4).
- Produces: `l4d_inputstats.smx` 0.4.0 emitting `L4DM id=<id> k=sikill w=<weapon> hs=<0|1> dist=<units> pre=<deg> back=<deg> cls=<smoker|boomer|hunter> v=3`, signed through `PugLog`; DEBUG-only `sm_inputstats_emit sikill` and `sm_inputstats_emit sikill_left`.

- [ ] **Step 1: Pin the format the self-test will emit**

vitest cannot run SourcePawn, so this step pins the parser to the plugin's format string instead; Task 11 swaps in lines captured off a real server.

Append to `tests/siKillParse.test.ts`:

```ts
/**
 * Plugin 0.4.0 lines, written out from EmitSiKillLine's format string in
 * plugin/l4d_inputstats.sp (the DEBUG self-test's fixed values), field for
 * field. Replace with lines captured off the local server in Task 11.
 */
const FORMAT_0_4 = [
  'L 10/17/2026 - 21:00:00: L4DM id=76561197960287930 k=sikill w=test_weapon hs=1 dist=512 pre=180.0 back=10.0 cls=hunter v=3',
  'L 10/17/2026 - 21:00:01: L4DM id=76561197960287930 k=sikill w=test_weapon hs=1 dist=512 pre=180.0 back=-1.0 cls=hunter v=3',
];

describe('lines in the 0.4.0 format', () => {
  it('parse to what the self-test means', () => {
    expect(parseLogLine(FORMAT_0_4[0])).toMatchObject({ kind: 'si_kill', weapon: 'test_weapon', headshot: true, dist: 512, pre: 180, back: 10, victimClass: 'hunter' });
    expect(parseLogLine(FORMAT_0_4[1])).toMatchObject({ back: -1 });
  });
});
```

Run: `npx vitest run tests/siKillParse.test.ts`
Expected: PASS (the parser from Task 4 already reads this format; the test is the contract the plugin must meet).

- [ ] **Step 2: Add the build script**

Create `plugin/build-inputstats.sh` (then `chmod +x plugin/build-inputstats.sh`):

```bash
#!/usr/bin/env bash
# Local compile via wine + the Rotoblin tree's spcomp (SourcePawn 1.12).
# Absolute unix paths break spcomp under wine -> copy in, compile relative, copy out.
# Mirrors build-sprayreport.sh, but builds only l4d_inputstats.
#
#   ./build-inputstats.sh            l4d_inputstats.smx, the one to stage
#   DEBUG=1 ./build-inputstats.sh    l4d_inputstats_debug.smx, with the
#                                    sm_inputstats_emit self-test. Never stage it.
set -euo pipefail
cd "$(dirname "$0")"
# PUG_SCRIPTING overrides the tree, for testing the build against a scratch copy.
SCRIPTING=${PUG_SCRIPTING:-/home/volence/l4d/Rotoblin-AZMod/SourceCode/scripting-az}
cp l4d_inputstats.sp "$SCRIPTING/l4d_inputstats.sp"
# Signed log lines: shared with pug-match, l4d_lilac_report, l4d_spray_report,
# l4d_cvarwatch and consistency/plugin/l4d_consistency, which need the same
# two files beside them when they are compiled.
cp pug-logauth.inc "$SCRIPTING/pug-logauth.inc"
cp pug-hmac.inc "$SCRIPTING/pug-hmac.inc"
trap 'rm -f "$SCRIPTING/l4d_inputstats.sp" "$SCRIPTING/pug-logauth.inc" "$SCRIPTING/pug-hmac.inc"' EXIT
OUT=l4d_inputstats.smx
DEFS=""
if [ "${DEBUG:-0}" = "1" ]; then OUT=l4d_inputstats_debug.smx; DEFS="DEBUG=1"; fi
(cd "$SCRIPTING" && wine ./spcomp.exe l4d_inputstats.sp -o "$OUT" -iinclude $DEFS)
mv "$SCRIPTING/$OUT" "./$OUT"
echo "built: $(pwd)/$OUT"
```

Run: `plugin/build-inputstats.sh` on the unchanged 0.3.0 source.
Expected: `built: .../plugin/l4d_inputstats.smx` with no errors. This proves the script before the code changes.

- [ ] **Step 3: Bump the version and add the constants and state**

In `plugin/l4d_inputstats.sp`, change `#define PLUGIN_VERSION "0.3.0"` to `#define PLUGIN_VERSION "0.4.0"`. Update the header comment's first paragraph to add, after "Captures the timing of button PRESS EDGES, and how long each press was held, and ships one line per burst.":

```
 * Since 0.4.0 it also keeps each survivor's last few hundred milliseconds of
 * view angles and ships one line per human SI kill (k=sikill), for the aim
 * rules (docs/superpowers/specs/2026-10-17-aimbot-rules-design.md).
```

After `#define TEAM_INFECTED 3` add:

```sourcepawn
#define TEAM_SURVIVOR 2
/** m_zombieClass of the SI a kill line names. The tank (5) is not counted. */
#define ZC_SMOKER 1
#define ZC_BOOMER 2
#define ZC_HUNTER 3

/** The sikill line's own wire version. NOT WIRE_VERSION: src/logParse.ts
 *  still requires v=2 on the stall and burst lines, and reads this new shape
 *  as v=3. */
#define SIKILL_WIRE 3

/** View angles of the last ANG_RING usercmds per survivor: 400 ms at 100
 *  tick, 312 ms at 128, either way enough for the 300 ms before a kill. */
#define ANG_RING 40
#define PRE_SECONDS 0.3
#define BACK_SECONDS 1.0
/** Kills per survivor waiting on their one second look back. Nobody kills
 *  four SI inside a second; a fifth is simply not recorded. */
#define MAX_PENDING 4
#define PENDING_SLOTS ((MAXPLAYERS + 1) * MAX_PENDING)
/** g_fKillBack before any usercmd arrived after the kill: emitted as -1. */
#define BACK_NONE 999.0
```

After the stall state block (after `int  g_iStallsThisRound[MAXPLAYERS + 1];`) add:

```sourcepawn
// --- view angles and SI kills (0.4.0) ----------------------------------------
float g_fRingPitch[MAXPLAYERS + 1][ANG_RING];
float g_fRingYaw[MAXPLAYERS + 1][ANG_RING];
int   g_iRingTick[MAXPLAYERS + 1][ANG_RING];
int   g_iRingHead[MAXPLAYERS + 1];		// next slot to write
int   g_iRingLen[MAXPLAYERS + 1];		// entries written since the last reset

// One kill waiting on its look back, per slot. A client's slots are
// client * MAX_PENDING .. client * MAX_PENDING + MAX_PENDING - 1, flattened
// so no array needs a third dimension.
bool  g_bKillOpen[PENDING_SLOTS];
int   g_iKillSerial[PENDING_SLOTS];		// which timer owns the slot
float g_fKillRefPitch[PENDING_SLOTS];	// the view 300 ms before the kill
float g_fKillRefYaw[PENDING_SLOTS];
float g_fKillPre[PENDING_SLOTS];
float g_fKillBack[PENDING_SLOTS];		// closest to the reference since the kill
int   g_iKillHs[PENDING_SLOTS];
int   g_iKillDist[PENDING_SLOTS];
int   g_iKillClass[PENDING_SLOTS];
char  g_sKillWeapon[PENDING_SLOTS][32];
int   g_iKillSerialNext;
```

- [ ] **Step 4: Hook the new events and add the self-test case**

In `OnPluginStart`, after `HookEvent("player_death", Event_PlayerDeath);` add:

```sourcepawn
	HookEvent("player_spawn", Event_PlayerSpawn);
	HookEvent("player_team", Event_PlayerTeam);
```

and change the DEBUG `RegAdminCmd` description string to:

```sourcepawn
		"DEBUG BUILD: sm_inputstats_emit <fire|pounce|bhop> <intervals> | sikill | sikill_left - ship a synthetic line through the real encode and emit path.");
```

In `Cmd_Emit`, directly after the two `GetCmdArg` calls, add:

```sourcepawn
	// The sikill line, with angles run through the real AngleBetween: a
	// 180 degree turn for pre and a 10 degree pitch for back, so the wire
	// should read pre=180.0 back=10.0 (or back=-1.0 for the left case).
	if (StrEqual(kind, "sikill") || StrEqual(kind, "sikill_left")) {
		float pre = AngleBetween(0.0, 0.0, 0.0, 180.0);
		float back = StrEqual(kind, "sikill") ? AngleBetween(10.0, 0.0, 0.0, 0.0) : -1.0;
		EmitSiKillLine("76561197960287930", "test_weapon", 1, 512, pre, back, "hunter");
		ReplyToCommand(client, "[inputstats] emitted a synthetic %s line for the test steamid", kind);
		return Plugin_Handled;
	}
```

and change its usage line to `"usage: sm_inputstats_emit <fire|pounce|bhop> <intervals 1..%d> | sikill | sikill_left"`.

- [ ] **Step 5: The lifecycle: death, disconnect, spawn, team change, map end**

Replace `OnClientDisconnect` and `Event_PlayerDeath` with:

```sourcepawn
public void OnClientDisconnect(int client)
{
	FlushAll(client);
	// The killer left before the look back: those kills go out as unknown.
	CloseKills(client);
	ResetClient(client);
}

public void Event_PlayerDeath(Event e, const char[] n, bool b)
{
	int client = GetClientOfUserId(e.GetInt("userid"));
	if (client < 1) return;
	// First, while the victim is still what they were: the record reads the
	// ATTACKER's ring and the victim's class, never the victim's capture.
	TakeSiKill(e, client);
	// A survivor who dies with kills still waiting never looks back.
	CloseKills(client);
	FlushAll(client);
	ResetCapture(client);
}

public void Event_PlayerSpawn(Event e, const char[] n, bool b)
{
	int client = GetClientOfUserId(e.GetInt("userid"));
	if (client > 0) ResetRing(client);
}

public void Event_PlayerTeam(Event e, const char[] n, bool b)
{
	int client = GetClientOfUserId(e.GetInt("userid"));
	if (client < 1) return;
	// Leaving the survivors is leaving: the look back is unknown.
	CloseKills(client);
	ResetRing(client);
}

/** Timers die with the map (TIMER_FLAG_NO_MAPCHANGE), so anything still
 *  waiting goes out now as unknown rather than never. */
public void OnMapEnd()
{
	for (int i = 1; i <= MaxClients; i++) CloseKills(i);
}
```

Add `ResetRing(c);` as the last line of `ResetClient(int c)`, and add the helper:

```sourcepawn
void ResetRing(int c)
{
	g_iRingHead[c] = 0;
	g_iRingLen[c] = 0;
}
```

- [ ] **Step 6: Record the view on every survivor usercmd**

In `OnPlayerRunCmdPre`, directly after `TrackStall(client, tick, seq);`, add:

```sourcepawn
	// Survivors only: the ring is read for a survivor's SI kill. Float stores
	// and, only while a kill waits on its look back, one AngleBetween per
	// waiting kill. Still nothing formatted here.
	if (GetClientTeam(client) == TEAM_SURVIVOR) TrackView(client, angles, tick);
```

and add, after `Lunging`:

```sourcepawn
/** Push this usercmd's view onto the ring, and bring every kill waiting on
 *  its look back closer if this view is nearer where the flick started. */
void TrackView(int client, const float angles[3], int tick)
{
	int h = g_iRingHead[client];
	g_fRingPitch[client][h] = angles[0];
	g_fRingYaw[client][h] = angles[1];
	g_iRingTick[client][h] = tick;
	g_iRingHead[client] = (h + 1) % ANG_RING;
	if (g_iRingLen[client] < ANG_RING) g_iRingLen[client]++;

	int first = client * MAX_PENDING;
	for (int s = first; s < first + MAX_PENDING; s++) {
		if (!g_bKillOpen[s]) continue;
		float d = AngleBetween(angles[0], angles[1], g_fKillRefPitch[s], g_fKillRefYaw[s]);
		if (d < g_fKillBack[s]) g_fKillBack[s] = d;
	}
}

/** The great-circle angle between two views (pitch, yaw; roll ignored), in
 *  degrees: a roll-free 180 degree turn reads as 180. */
float AngleBetween(float p1, float y1, float p2, float y2)
{
	float a[3], b[3], va[3], vb[3];
	a[0] = p1; a[1] = y1; a[2] = 0.0;
	b[0] = p2; b[1] = y2; b[2] = 0.0;
	GetAngleVectors(a, va, NULL_VECTOR, NULL_VECTOR);
	GetAngleVectors(b, vb, NULL_VECTOR, NULL_VECTOR);
	float dot = GetVectorDotProduct(va, vb);
	if (dot > 1.0) dot = 1.0;
	else if (dot < -1.0) dot = -1.0;
	return RadToDeg(ArcCosine(dot));
}
```

- [ ] **Step 7: Take the kill record, the timer and the emit**

Add, after `AngleBetween`:

```sourcepawn
/**
 * A human survivor killed a human SI (not a ghost, not a bot, not a common,
 * not the tank): record what the attacker's view did in the 300 ms before,
 * and start the one second look back. Bots on either side only with the
 * TEST ONLY l4d_inputstats_bots, so the local rig can kill a bot hunter.
 */
void TakeSiKill(Event e, int victim)
{
	if (!g_cvEnabled.BoolValue || !IsClientInGame(victim) || GetClientTeam(victim) != TEAM_INFECTED) return;
	bool bots = g_cvBots.BoolValue;
	if (IsFakeClient(victim) && !bots) return;
	int cls = GetEntProp(victim, Prop_Send, "m_zombieClass");
	if (cls < ZC_SMOKER || cls > ZC_HUNTER) return;
	int attacker = GetClientOfUserId(e.GetInt("attacker"));
	if (attacker < 1 || attacker == victim || !IsClientInGame(attacker) || GetClientTeam(attacker) != TEAM_SURVIVOR) return;
	if (IsFakeClient(attacker) && !bots) return;

	int slot = -1;
	int first = attacker * MAX_PENDING;
	for (int s = first; s < first + MAX_PENDING; s++) {
		if (!g_bKillOpen[s]) { slot = s; break; }
	}
	if (slot < 0) return;

	// The kill-tick view is the newest usercmd's. pre is the largest distance
	// from it to any view in the 300 ms before; the reference for the look
	// back is the oldest view inside that window ("the view 300 ms before").
	float killP, killY;
	int len = g_iRingLen[attacker];
	if (len == 0) {
		float eye[3];
		GetClientEyeAngles(attacker, eye);
		killP = eye[0]; killY = eye[1];
	} else {
		int newest = (g_iRingHead[attacker] + ANG_RING - 1) % ANG_RING;
		killP = g_fRingPitch[attacker][newest];
		killY = g_fRingYaw[attacker][newest];
	}
	float pre = 0.0, refP = killP, refY = killY;
	if (len > 1) {
		int newest = (g_iRingHead[attacker] + ANG_RING - 1) % ANG_RING;
		int oldest = g_iRingTick[attacker][newest] - RoundToCeil(PRE_SECONDS / GetTickInterval());
		for (int i = 1; i < len; i++) {
			int s = (newest + ANG_RING - i) % ANG_RING;
			if (g_iRingTick[attacker][s] < oldest) break;
			float d = AngleBetween(killP, killY, g_fRingPitch[attacker][s], g_fRingYaw[attacker][s]);
			if (d > pre) pre = d;
			refP = g_fRingPitch[attacker][s];
			refY = g_fRingYaw[attacker][s];
		}
	}

	float from[3], to[3];
	GetClientAbsOrigin(attacker, from);
	GetClientAbsOrigin(victim, to);
	char weapon[32];
	e.GetString("weapon", weapon, sizeof(weapon));
	// The wire refuses anything outside [a-z0-9_]; normalise rather than
	// ship a line the parser drops.
	for (int i = 0; weapon[i] != '\0'; i++) {
		if (!IsCharLower(weapon[i]) && !IsCharNumeric(weapon[i]) && weapon[i] != '_') weapon[i] = '_';
	}
	if (weapon[0] == '\0') strcopy(weapon, sizeof(weapon), "unknown");

	g_bKillOpen[slot] = true;
	g_iKillSerial[slot] = ++g_iKillSerialNext;
	g_fKillRefPitch[slot] = refP;
	g_fKillRefYaw[slot] = refY;
	g_fKillPre[slot] = pre;
	g_fKillBack[slot] = BACK_NONE;
	g_iKillHs[slot] = e.GetBool("headshot") ? 1 : 0;
	g_iKillDist[slot] = RoundToNearest(GetVectorDistance(from, to));
	g_iKillClass[slot] = cls;
	strcopy(g_sKillWeapon[slot], sizeof(g_sKillWeapon[]), weapon);

	DataPack pack;
	CreateDataTimer(BACK_SECONDS, Timer_KillBack, pack, TIMER_FLAG_NO_MAPCHANGE);
	pack.WriteCell(slot);
	pack.WriteCell(g_iKillSerial[slot]);
}

public Action Timer_KillBack(Handle timer, DataPack pack)
{
	pack.Reset();
	int slot = pack.ReadCell();
	int serial = pack.ReadCell();
	// Not ours any more: the killer left, died or changed team, and the
	// line already went out as unknown.
	if (g_bKillOpen[slot] && g_iKillSerial[slot] == serial) EmitSiKill(slot / MAX_PENDING, slot, false);
	return Plugin_Stop;
}

/** Everything this client has waiting goes out now, with back unknown. */
void CloseKills(int client)
{
	if (client < 1 || client > MaxClients) return;
	int first = client * MAX_PENDING;
	for (int s = first; s < first + MAX_PENDING; s++) {
		if (g_bKillOpen[s]) EmitSiKill(client, s, true);
	}
}

void EmitSiKill(int client, int slot, bool unknown)
{
	g_bKillOpen[slot] = false;
	if (!IsClientConnected(client)) return;
	char id[32];
	if (!GetClientAuthId(client, AuthId_SteamID64, id, sizeof(id))) {
		// Under sv_lan 1 the 64-bit form is unavailable; the web normalises the
		// STEAM_ form, same as every other L4DM line.
		if (!GetClientAuthId(client, AuthId_Steam2, id, sizeof(id))) return;
	}
	float back = (unknown || g_fKillBack[slot] >= BACK_NONE) ? -1.0 : g_fKillBack[slot];
	char cls[8];
	switch (g_iKillClass[slot]) {
		case ZC_SMOKER: strcopy(cls, sizeof(cls), "smoker");
		case ZC_BOOMER: strcopy(cls, sizeof(cls), "boomer");
		default: strcopy(cls, sizeof(cls), "hunter");
	}
	EmitSiKillLine(id, g_sKillWeapon[slot], g_iKillHs[slot], g_iKillDist[slot], g_fKillPre[slot], back, cls);
}

/**
 * The ONE place the sikill format exists, so the self-test cannot drift from
 * the real path. Same anchoring as every L4DM line: the marker opens the
 * line and the only identity on it is a steamid. About 130 bytes signed.
 */
void EmitSiKillLine(const char[] id, const char[] weapon, int hs, int dist, float pre, float back, const char[] cls)
{
	PugLog("L4DM id=%s k=sikill w=%s hs=%d dist=%d pre=%.1f back=%.1f cls=%s v=%d",
		id, weapon, hs, dist, pre, back, cls, SIKILL_WIRE);
}
```

Note on `EmitSiKill` during `OnClientDisconnect`: the client is still connected and authorised there, so `GetClientAuthId` succeeds; `IsClientConnected` guards the timer path only.

- [ ] **Step 8: Compile both builds**

Run: `plugin/build-inputstats.sh && DEBUG=1 plugin/build-inputstats.sh`
Expected: `built: .../plugin/l4d_inputstats.smx` and `built: .../plugin/l4d_inputstats_debug.smx`, no errors and no warnings. If spcomp warns about an unused symbol in the non-DEBUG build (for example nothing calls `EmitSiKillLine` except `EmitSiKill`, which is used, so it should not), fix the cause rather than suppress it.

- [ ] **Step 9: Run the site tests once more**

Run: `npx vitest run tests/siKillParse.test.ts tests/inputBurstEndToEnd.test.ts tests/inputStalls.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit (the `.smx` files are gitignored build output)**

```bash
git add plugin/l4d_inputstats.sp plugin/build-inputstats.sh tests/siKillParse.test.ts
git commit -m "l4d_inputstats 0.4.0: keep survivors' view angles and ship one signed sikill line per human SI kill" -- plugin/l4d_inputstats.sp plugin/build-inputstats.sh tests/siKillParse.test.ts
```

---

### Task 11: Prove the plugin on the local server and write the runbook

**Files:**
- Modify: `plugin/TESTING.md` (a new section at the end)
- Modify: `tests/siKillParse.test.ts` (replace `FORMAT_0_4` with captured lines)

**Interfaces:**
- Consumes: `plugin/l4d_inputstats_debug.smx` (Task 10).
- Produces: captured 0.4.0 lines pinned in tests; the runbook.

This task touches only the shared local server. Read the Global Constraints on it again before starting.

- [ ] **Step 1: Check the local server is free**

Run: `RPORT=27055 python3 /home/volence/l4d/nightmode/rcon.py 'status'`
Expected: a status listing. If it shows a human player you did not put there, or rcon cannot connect (the server is not running), stop this task, leave everything as it is, and record in the final report that the local run is pending for the owner. Do not start, restart or kill a srcds.

- [ ] **Step 2: Install the DEBUG build in place of the shipped one, keeping a backup**

```bash
PL=/home/volence/l4d1-ds/server/left4dead/addons/sourcemod/plugins
cp "$PL/l4d_inputstats.smx" /tmp/claude-1000/l4d_inputstats.smx.bak 2>/dev/null || true
cp /home/volence/l4d/pug/plugin/l4d_inputstats_debug.smx "$PL/l4d_inputstats.smx"
RPORT=27055 python3 /home/volence/l4d/nightmode/rcon.py 'sm plugins reload l4d_inputstats' 'l4d_inputstats_version' 'log on'
```

Expected: `l4d_inputstats_version` reads `0.4.0`.

- [ ] **Step 3: The self-test**

```bash
RPORT=27055 python3 /home/volence/l4d/nightmode/rcon.py 'sm_inputstats_emit sikill' 'sm_inputstats_emit sikill_left'
grep -h 'k=sikill' $(ls -t /home/volence/l4d1-ds/server/left4dead/logs/L*.log | head -1) | tail -2
```

Expected: two lines ending `pre=180.0 back=10.0 cls=hunter v=3` and `pre=180.0 back=-1.0 cls=hunter v=3` (plus ` lseq=... mac=...` if the box has a log secret).

- [ ] **Step 4: A real kill after a scripted 180 degree turn (needs a client)**

Only if the owner's client can be launched through the HUD harness (owner permission on record). Otherwise skip to Step 6 and record this step as pending for the owner.

On the server:

```bash
RPORT=27055 python3 /home/volence/l4d/nightmode/rcon.py 'sv_cheats 1' 'l4d_inputstats_bots 1' 'director_stop' 'z_hunter_health 1'
```

In the client console, as a survivor holding an SMG (`give smg`), facing open ground:

```
getpos
z_spawn hunter
alias flick "setang 0 180 0; wait 50; setang 0 0 0; +attack; wait 5; -attack; wait 20; setang 0 180 0"
```

Use the yaw `getpos` printed in place of `0` (and that yaw plus 180 in place of `180`) so the hunter sits in the crosshair at the unturned yaw, then run `flick`.

Expected in the newest server log: one `k=sikill` line for the client's `STEAM_` id with `w=smg`, `cls=hunter`, `pre=` at least `170.0` and `back=` at most `10.0`. Also kill a hunter without turning (`pre` small) and confirm a common infected kill and a tank kill (`z_spawn tank`, `z_tank_health 1`) emit nothing.

- [ ] **Step 5: Record which weapon names the game sends**

From the same session, kill one SI each with the pistol, dual pistols (`give pistol` twice) and the hunting rifle, and note the `w=` values. If any differs from `smg`, `pistol`, `dual_pistols`, `hunting_rifle`, update `HS_GROUPS` in `src/aimRules.ts` and the `weapon groups` test in `tests/aimHeadshots.test.ts` to the real names, and say so in the commit message.

- [ ] **Step 6: Restore the server**

```bash
PL=/home/volence/l4d1-ds/server/left4dead/addons/sourcemod/plugins
if [ -f /tmp/claude-1000/l4d_inputstats.smx.bak ]; then cp /tmp/claude-1000/l4d_inputstats.smx.bak "$PL/l4d_inputstats.smx"; fi
RPORT=27055 python3 /home/volence/l4d/nightmode/rcon.py 'l4d_inputstats_bots 0' 'z_hunter_health 250' 'director_start' 'sm plugins reload l4d_inputstats'
```

- [ ] **Step 7: Pin the captured lines**

In `tests/siKillParse.test.ts`, replace the two `FORMAT_0_4` entries with the lines captured in Steps 3 and 4 verbatim (keep any `lseq`/`mac` trailer; the parser ignores it), and change the comment above to say they were captured off the local server on the date of the run. Keep the assertions; for the Step 4 line assert `{ kind: 'si_kill', weapon: 'smg', victimClass: 'hunter' }` and `pre >= 170`, `back <= 10`. If Step 4 was skipped, leave the format-written lines and their comment as they are.

Run: `npx vitest run tests/siKillParse.test.ts`
Expected: PASS.

- [ ] **Step 8: Write the runbook**

Append to `plugin/TESTING.md`:

```markdown
## l4d_inputstats sikill verification (0.4.0)

The aim rules' kill line (`docs/superpowers/specs/2026-10-17-aimbot-rules-design.md`). Local
server only (`/home/volence/l4d1-ds`, rcon 27055, shared: `status` first).

1. Build both: `plugin/build-inputstats.sh && DEBUG=1 plugin/build-inputstats.sh`. Never stage
   `l4d_inputstats_debug.smx`.
2. Back up the box's `l4d_inputstats.smx`, copy the debug build over it, then
   `sm plugins reload l4d_inputstats`, `log on`. `l4d_inputstats_version` reads `0.4.0`.
3. `sm_inputstats_emit sikill` and `sm_inputstats_emit sikill_left`: the newest
   `left4dead/logs/L*.log` gets `... pre=180.0 back=10.0 cls=hunter v=3` and the same with
   `back=-1.0`.
4. With a client: `sv_cheats 1`, `l4d_inputstats_bots 1` (TEST ONLY, lets a bot hunter count),
   `director_stop`, `z_hunter_health 1`. As a survivor with an SMG, `z_spawn hunter` in the
   crosshair and run
   `alias flick "setang 0 <yaw+180> 0; wait 50; setang 0 <yaw> 0; +attack; wait 5; -attack; wait 20; setang 0 <yaw+180> 0"; flick`
   with the yaw from `getpos`. Expect `pre >= 170`, `back <= 10`. A common or tank kill emits
   nothing.
5. Restore: the backed-up `.smx`, `l4d_inputstats_bots 0`, `z_hunter_health 250`,
   `director_start`, reload.

`back=-1` means the killer disconnected, died or left the survivors inside the second after the
kill, or the map ended; the site never counts it as a return.
```

- [ ] **Step 9: Commit**

```bash
git add plugin/TESTING.md tests/siKillParse.test.ts
git commit -m "Pin the sikill lines l4d_inputstats 0.4.0 emitted on the local server and add its runbook" -- plugin/TESTING.md tests/siKillParse.test.ts
```

(If Step 5 changed `src/aimRules.ts` and `tests/aimHeadshots.test.ts`, add both to the `git add` and the `--` list, and say which names changed in the message.)

---

### Task 12: The one-week calibration report

**Files:**
- Create: `src/aimCalibration.ts`
- Create: `scripts/aim-calibration.ts`
- Test: `tests/aimCalibration.test.ts`

**Interfaces:**
- Consumes: `HS_GROUPS`, `HS_MIN_KILLS`, `groupOf`, `binomialTail`, `pooledRate`, `isFlickReturn` (Tasks 5, 6).
- Produces:
  - `interface AimCalibration { since: string; playerMatches: number; pools: { group: string; kills: number; headshots: number; rate: number | null }[]; hs: { group: string; scored: number; buckets: { below: number; count: number }[]; lowest: { steamid: string; matchId: number; kills: number; headshots: number; p: number }[] }[]; flicks: { counts: { flicks: number; playerMatches: number }[]; top: { steamid: string; matchId: number; flicks: number; kills: number }[] } }`
  - `aimCalibration(db: DB, now?: Date, days?: number): AimCalibration` (days default 7)

- [ ] **Step 1: Write the failing test**

Create `tests/aimCalibration.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { recordSiKill } from '../src/aimRules.js';
import { aimCalibration } from '../src/aimCalibration.js';

const NOW = new Date('2026-10-24T22:00:00.000Z');
let db: DB;
beforeEach(() => { db = openDb(':memory:'); });

function play(matchId: number, steamid: string, weapon: string, n: number, hs: number, flicks = 0, at = new Date('2026-10-20T20:00:00.000Z')): void {
  for (let i = 0; i < n; i++) {
    recordSiKill(db, {
      matchId, serverId: 1, steamid, weapon, headshot: i < hs, dist: 400,
      pre: i < flicks ? 120 : 6, back: i < flicks ? 10 : 2, victimClass: 'hunter',
    }, at);
  }
}

describe('aimCalibration', () => {
  it('reports pools, p-value buckets, the lowest p-values and flick counts over the window', () => {
    play(1, 'honest1', 'smg', 12, 4, 1);
    play(2, 'honest2', 'smg', 15, 6);
    play(3, 'cheat', 'smg', 16, 14, 2);
    play(4, 'sniper', 'hunting_rifle', 12, 9);
    play(5, 'old', 'smg', 20, 20, 0, new Date('2026-10-01T00:00:00.000Z')); // outside 7 days
    const r = aimCalibration(db, NOW);
    expect(r.playerMatches).toBe(4);
    expect(r.pools).toEqual([
      { group: 'auto', kills: 43, headshots: 24, rate: 24 / 43 },
      { group: 'rifle', kills: 12, headshots: 9, rate: 0.75 },
    ]);
    const auto = r.hs.find((h) => h.group === 'auto')!;
    expect(auto.scored).toBe(3);
    expect(auto.lowest[0]).toMatchObject({ steamid: 'cheat', matchId: 3, kills: 16, headshots: 14 });
    expect(auto.buckets.reduce((s, b) => s + b.count, 0)).toBe(3);
    expect(r.flicks.counts).toEqual([{ flicks: 0, playerMatches: 2 }, { flicks: 1, playerMatches: 1 }, { flicks: 2, playerMatches: 1 }]);
    expect(r.flicks.top[0]).toMatchObject({ steamid: 'cheat', matchId: 3, flicks: 2, kills: 16 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/aimCalibration.test.ts`
Expected: FAIL (`Cannot find module '../src/aimCalibration.js'`).

- [ ] **Step 3: Write the implementation**

Create `src/aimCalibration.ts`:

```ts
import type { DB } from './db.js';
import { HS_GROUPS, HS_MIN_KILLS, binomialTail, groupOf, isFlickReturn, pooledRate } from './aimRules.js';

/**
 * What a week of l4d_inputstats 0.4.0 data says about the aim rules, for the
 * owner to set the thresholds from before aim_rules goes on (spec,
 * "Calibration after one week of log"). The plugin measures at 100 Hz, which
 * is sharper than the 10 Hz replays the rules were found on, so the honest
 * distributions here, not the study's, are what the thresholds should sit
 * above. Read-only.
 */

/** Upper edges of the p-value buckets. */
const P_EDGES = [1e-5, 1e-4, 1e-3, 1e-2, 1e-1, 1.000001];
const LOWEST_SHOWN = 10;

export interface AimCalibration {
  since: string;
  playerMatches: number;
  /** Every group, enabled or not: the rifle's rate is what enables it. */
  pools: { group: string; kills: number; headshots: number; rate: number | null }[];
  hs: {
    group: string;
    /** Player-matches with at least HS_MIN_KILLS kills in the group. */
    scored: number;
    buckets: { below: number; count: number }[];
    lowest: { steamid: string; matchId: number; kills: number; headshots: number; p: number }[];
  }[];
  flicks: {
    counts: { flicks: number; playerMatches: number }[];
    top: { steamid: string; matchId: number; flicks: number; kills: number }[];
  };
}

interface Row { matchId: number; steamid: string; weapon: string; headshot: number; pre: number; back: number }

export function aimCalibration(db: DB, now = new Date(), days = 7): AimCalibration {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const rows = db.prepare(
    `SELECT match_id AS matchId, steamid, weapon, headshot, pre, back FROM si_kills
     WHERE match_id IS NOT NULL AND at >= ? AND at <= ? ORDER BY id`,
  ).all(since, now.toISOString()) as Row[];

  const byPm = new Map<string, Row[]>();
  for (const r of rows) {
    const key = `${r.matchId}|${r.steamid}`;
    const list = byPm.get(key) ?? [];
    list.push(r);
    byPm.set(key, list);
  }

  const pools = HS_GROUPS.map((g) => {
    const mine = rows.filter((r) => groupOf(r.weapon) === g);
    const headshots = mine.filter((r) => r.headshot).length;
    return { group: g.name, kills: mine.length, headshots, rate: mine.length ? headshots / mine.length : null };
  });

  const hs = HS_GROUPS.map((g) => {
    const scoredRows: AimCalibration['hs'][number]['lowest'] = [];
    for (const kills of byPm.values()) {
      const mine = kills.filter((k) => groupOf(k.weapon) === g);
      if (mine.length < HS_MIN_KILLS) continue;
      // Judged the way the rule judges: against the pool without this match,
      // or, for a group with no fallback, against this window's own rate.
      const rate = pooledRate(db, g, mine[0].matchId, now)?.rate ?? pools.find((p) => p.group === g.name)!.rate;
      if (rate === null) continue;
      const headshots = mine.filter((k) => k.headshot).length;
      scoredRows.push({ steamid: mine[0].steamid, matchId: mine[0].matchId, kills: mine.length, headshots, p: binomialTail(headshots, mine.length, rate) });
    }
    scoredRows.sort((a, b) => a.p - b.p);
    const buckets = P_EDGES.map((below, i) => ({
      below,
      count: scoredRows.filter((s) => s.p < below && (i === 0 || s.p >= P_EDGES[i - 1])).length,
    }));
    return { group: g.name, scored: scoredRows.length, buckets, lowest: scoredRows.slice(0, LOWEST_SHOWN) };
  });

  const perPm = [...byPm.values()].map((kills) => ({
    steamid: kills[0].steamid, matchId: kills[0].matchId, kills: kills.length, flicks: kills.filter(isFlickReturn).length,
  }));
  const countMap = new Map<number, number>();
  for (const p of perPm) countMap.set(p.flicks, (countMap.get(p.flicks) ?? 0) + 1);
  const counts = [...countMap].sort((a, b) => a[0] - b[0]).map(([flicks, playerMatches]) => ({ flicks, playerMatches }));
  const top = perPm.filter((p) => p.flicks > 0).sort((a, b) => b.flicks - a.flicks || b.kills - a.kills).slice(0, LOWEST_SHOWN);

  return { since, playerMatches: byPm.size, pools, hs, flicks: { counts, top } };
}
```

Create `scripts/aim-calibration.ts`:

```ts
/**
 * The aim rules' one-week calibration report (src/aimCalibration.ts).
 *
 *   npx tsx scripts/aim-calibration.ts [--db PATH] [--days N]
 *
 * Read-only. Run it on a COPY of the production database (ops/pull-db-backups.sh),
 * never against the live file. Prints the pooled headshot rate per weapon
 * group (the hunting rifle's is what would enable it), how the honest
 * player-matches spread over p-values, the lowest ten, and how many
 * flick-and-return kills each player-match had. nepmir's match 722 (14 of
 * 16, 2 flicks) is the yardstick: a threshold that would not still fire on
 * it is too loose.
 */
import { openDb } from '../src/db.js';
import { aimCalibration } from '../src/aimCalibration.js';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const db = openDb(flag('--db') ?? process.env.DB_PATH ?? 'pug.db');
const days = Number(flag('--days') ?? 7);
if (!Number.isInteger(days) || days < 1 || days > 90) {
  console.error(`--days is a whole number of days, 1 to 90; got ${flag('--days')}`);
  process.exit(1);
}
const r = aimCalibration(db, new Date(), days);

console.log(`since ${r.since}: ${r.playerMatches} player-matches with SI kills`);
console.log('\npools:');
for (const p of r.pools) console.log(`  ${p.group}: ${p.headshots} of ${p.kills} headshots${p.rate === null ? '' : ` (${p.rate.toFixed(3)})`}`);
for (const h of r.hs) {
  console.log(`\n${h.group}: ${h.scored} player-matches with 10+ kills`);
  for (const b of h.buckets) console.log(`  p < ${b.below.toExponential(0)}: ${b.count}`);
  for (const l of h.lowest) console.log(`  ${l.steamid} match ${l.matchId}: ${l.headshots} of ${l.kills}, p = ${l.p.toExponential(1)}`);
}
console.log('\nflick-and-return kills per player-match:');
for (const c of r.flicks.counts) console.log(`  ${c.flicks}: ${c.playerMatches}`);
for (const t of r.flicks.top) console.log(`  ${t.steamid} match ${t.matchId}: ${t.flicks} of ${t.kills}`);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/aimCalibration.test.ts`
Expected: PASS. If a hand-computed number in the expectation is off (for example the `auto` pool totals), recompute it from the fixture rather than loosening the assertion.

- [ ] **Step 5: Full suite, typecheck and commit**

Run: `npm test && npm run typecheck`
Expected: PASS, no errors.

```bash
git add src/aimCalibration.ts scripts/aim-calibration.ts tests/aimCalibration.test.ts
git commit -m "Add the aim rules' one-week calibration report over the SI kill data" -- src/aimCalibration.ts scripts/aim-calibration.ts tests/aimCalibration.test.ts
```

---

## Rollout checklist (needs the owner's explicit go-ahead; nothing here runs as part of the plan)

Each numbered stage waits for the owner to say go. Before any of it: `npm test` and `npm run typecheck` pass on the branch, and the owner has read "Spec gaps and readings" above (items 5, 6 and 9 change what they will see during the log week).

1. **Web, stage 1 (spec rollout step 1).** Merge to `master`. With the owner's go-ahead, run `./deploy-web.sh` from the pug checkout (web deploys may go out during matches; the script waits for a safe moment). Verify with the tree-hash check in the PUG deploy verification notes. Then confirm on the site: Settings shows Aim rules = Log only; the staff guide has the Aim rules panel; the next LilAC aimbot flag with `ldelta >= 60` (if any) shows "high severity" on the file and posts the big snap line in the admin channel. A and C have no data yet (no 0.4.0 box), so nothing else changes.
2. **Plugin 0.4.0, stage 2 (spec rollout step 2).** With the owner's go-ahead: build `plugin/build-inputstats.sh` (not the DEBUG build), copy `plugin/l4d_inputstats.smx` to `/home/volence/l4d/deploy/overrides/left4dead/addons/sourcemod/plugins/l4d_inputstats.smx`, commit that in the deploy repo, and stage it on each of the five pool boxes with `/home/volence/l4d/deploy/tools/stage-on-restart.sh <target> addons/sourcemod/plugins/l4d_inputstats.smx` for `dallas`, `riverside-3`, `riverside-4`, `riverside-5`, `riverside-6`. It applies at each box's next restart, never mid-match. Check `--status` on each. Copy the source into the public mirror (`riverside-l4d-plugins`) only if the owner wants it there.
3. **First data.** After the first match on a 0.4.0 box: `si_kills` has rows for that match (a read-only query on the server's database, with the owner's OK), and `aim_match_scans` has the match. With `log`, no aim post appears in Discord.
4. **After one week (spec rollout step 3).** Pull a database copy (`ops/pull-db-backups.sh`) and run `npx tsx scripts/aim-calibration.ts --db <copy>`. Report to the owner: the `auto` and `rifle` pools, the honest p-value spread and lowest ten, the flick count distribution, and whether nepmir-like values (14 of 16 against the pool, 2 flicks) would still fire. The owner sets thresholds (a code change to the constants in `src/aimRules.ts`, its own small task with tests) and the rifle group's fallback, then switches Settings, Aim rules to On.
5. **Memory.** Add a one-line index entry and a topic file for the aim rules (what is live, the log-week date, the calibration due date).

## Self-review notes

- Spec coverage: rules A, B, C and escalation (Tasks 5, 1, 6, 7); plugin ring, kill record, look back, edge cases, signing, self-test, 0.4.0 (Task 10, local check Task 11); table (Task 3); parsing, rejection and storage from the wire (Task 4); `src/aimRules.ts` with A/C in the end-of-match sweep and B where LilAC flags are inserted (Tasks 7, 1); flag text with the numbers (Tasks 5, 6, 7); `aim_rules` off/log/on with B always on (Task 7); every listed site unit test (Tasks 1, 4, 5, 6, 7); calibration (Task 12); rollout (checklist).
- Names used across tasks: `recordSiKill`, `SiKillInput`, `KillRow`, `HsGroup`, `HS_GROUPS`, `groupOf`, `pooledRate`, `PooledRate.poolKills`, `hsShare`, `hsNote`, `isFlickReturn`, `flickReturns`, `flickNote`, `aimRulesMode`, `AIM_SOURCE`, `AimKind`, `evaluateAimMatch`, `scanAimMatches`, `AimPost.kind`, `aim_flag.rule`, `aimAdapter`, `aimCalibration`. Checked for one spelling each.
