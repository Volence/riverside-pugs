# Line-of-sight recording (wallhack detection, plan 1 of 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every replay frame records which spawned human infected each survivor could actually see, so plan 2's analyzer can score aiming at infected hidden behind walls.

**Architecture:** The plugin's 10 Hz replay sampler traces line of sight from each living survivor to each spawned, non-tank human infected (three points each, `MASK_VISIBLE`, players and commons ignored) and packs the 4x4 result into frame bytes 6-7, which every existing writer zeroes and no reader reads. Header byte 158 = 1 marks a file that records it. The file format's size and version do not change, so no existing reader needs touching; `replayFormat.ts` gains a decoder field and one helper. Plan 2 (analyzer version 5 and the admin screens) is written once real files exist.

**Tech Stack:** SourcePawn 1.12 (Rotoblin tree spcomp under wine, `plugin/build.sh`), TypeScript + vitest (`npm test`, `npm run typecheck`).

**Spec:** `docs/superpowers/specs/2026-09-23-spawned-infected-los-design.md` (sections 1, 2, 5 and 7 are this plan; 3, 4 and 6 are plan 2).

## Global Constraints

- Frame bytes 6-7: u16 little-endian; bit `survivorRank * 4 + infectedRank`.
- Ranks: occupied slots (non-empty SteamID in the header) whose side-mask bit is 0, in slot order, are survivor ranks 0-3; bit 1, infected ranks 0-3; a fifth on one side gets no rank.
- Header byte 158: 1 = visibility recorded; 0 (every existing file) = unknown, never "saw nothing".
- Visible = any of three traces clear: target eye, origin +36 z, origin +8 z. Mask `MASK_VISIBLE`; the filter ignores clients 1..MaxClients and entities of class `infected`.
- Skipped pairs (bit stays 0): survivor dead, incapped or ledge-hanging; infected dead, ghost or tank; the infected currently pinning that survivor.
- Plugin version becomes **0.3.8**. `worktree-balance-analytics` is also editing `plugin/pug-match.sp` at 0.3.6: whichever merges second rebases and takes the next number.
- `CLIP_MIN` becomes **0.4** (owner, 2026-09-23). The `clip-min` worktree holds an uncommitted 0.35; do not touch that worktree.
- Never deploy, restart or rcon a live server with players on it (see the deploy checks in Task 5).
- No em dashes in code, comments, commits or docs.

---

### Task 1: Ghost clip threshold to 0.4

**Files:**
- Modify: `src/integrity/constants.ts` (the `CLIP_MIN: 0.7,` line inside `TUNING`, around line 187)

**Interfaces:**
- Consumes: nothing.
- Produces: `TUNING.CLIP_MIN === 0.4`. Tests already reference `TUNING.CLIP_MIN` symbolically (`tests/integrityRun.test.ts:87`, `tests/integrityGhostTrack.test.ts:553`), so none change.

- [ ] **Step 1: Check nobody else has landed it**

Run: `git log --all --oneline -S'CLIP_MIN: 0.4' -- src/integrity/constants.ts`
Expected: no output. If a commit appears, skip this task.

- [ ] **Step 2: Change the value and its comment**

Replace the line `  CLIP_MIN: 0.7,` with:

```ts
  /** Set by the owner on 2026-09-23. No real player in history has scored above
   *  0.261, while simulated wallhackers reach 0.7 in only 7 to 17% of rounds, so
   *  0.7 missed most cheaters for no gain. 0.4 still flags nobody in history.
   *  Revisit after the calibration session (spec section 6). */
  CLIP_MIN: 0.4,
```

If a doc comment already sits directly above `CLIP_MIN`, keep it and add these four lines after it instead of replacing it.

- [ ] **Step 3: Run the analyzer tests**

Run: `npx vitest run tests/integrity*.test.ts`
Expected: all pass. If `integrityRun.test.ts` fails because a synthetic clip now scores between 0.4 and its expected bound, read the assertion: a test pinned to the old number is wrong, a test asserting behaviour is right. Report which it is before changing anything.

- [ ] **Step 4: Commit**

```bash
git add src/integrity/constants.ts
git commit -m "Lower the ghost clip threshold to 0.4, the owner's call on 2026-09-23"
```

---

### Task 2: Decode visibility from replay frames

**Files:**
- Modify: `src/replayFormat.ts` (OFF table, `ReplayHeader`, `Frame`, `encodeHeader`, `decodeHeader`, `encodeFrame`, `decodeFrames`)
- Create: `tests/replayLos.test.ts`

**Interfaces:**
- Consumes: existing `ReplayHeader`, `Frame`, `encodeHeader`, `encodeFrame`, `decodeHeader`, `decodeFrames`, `parseReplay`, `HEADER_BYTES`, `VERSION`.
- Produces (plan 2 relies on these exact names):
  - `ReplayHeader.losKnown?: boolean` (decoder always sets it)
  - `Frame.los?: number` (raw u16 from bytes 6-7; decoder always sets it)
  - `export function sideRanks(h: Pick<ReplayHeader, 'slots' | 'infectedMask' | 'sidesKnown'>): { survivor: number[]; infected: number[] }`, each an 8-long array of rank or -1 per slot
  - `export function canSee(h: ReplayHeader, f: Frame, survivorSlot: number, infectedSlot: number): boolean | null` (null when the file does not record visibility or either slot has no rank on the right side)
  - `export const LOS_FLAG_OFFSET = 158`

- [ ] **Step 1: Write the failing tests**

Create `tests/replayLos.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  HEADER_BYTES, VERSION, LOS_FLAG_OFFSET,
  encodeHeader, decodeHeader, encodeFrame, decodeFrames, parseReplay,
  sideRanks, canSee, type ReplayHeader, type Frame,
} from '../src/replayFormat.js';

const ID = (n: number) => `7656119800000000${n}`;

function header(over: Partial<ReplayHeader> = {}): ReplayHeader {
  return {
    version: VERSION, token: 'a'.repeat(32), ordinal: 0, half: 1,
    playerHz: 10, entityHz: 10, map: 'l4d_vs_farm01_hilltop',
    startedUnix: 1790000000, indexOffset: 0, indexCount: 0, frameCount: 0,
    // Survivors in slots 0, 2, 5, 6; infected in 1, 3, 4, 7 (mask 0b10011010).
    slots: [ID(1), ID(2), ID(3), ID(4), ID(5), ID(6), ID(7), ID(8)],
    infectedMask: 0b10011010, sidesKnown: true, losKnown: true,
    ...over,
  };
}

function frame(los: number): Frame {
  return { tMs: 1000, players: [], entities: [], offset: 0, los };
}

function file(h: ReplayHeader, frames: Frame[]): Uint8Array {
  const parts = [encodeHeader(h), ...frames.map(encodeFrame)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

describe('sideRanks', () => {
  it('ranks each side in slot order from the side mask', () => {
    expect(sideRanks(header())).toEqual({
      survivor: [0, -1, 1, -1, -1, 2, 3, -1],
      infected: [-1, 0, -1, 1, 2, -1, -1, 3],
    });
  });

  it('skips empty slots', () => {
    const h = header({ slots: [ID(1), '', ID(3), ID(4), '', '', '', ''], infectedMask: 0b1000 });
    expect(sideRanks(h)).toEqual({
      survivor: [0, -1, 1, -1, -1, -1, -1, -1],
      infected: [-1, -1, -1, 0, -1, -1, -1, -1],
    });
  });

  it('gives a fifth player on one side no rank', () => {
    const h = header({ infectedMask: 0 });
    expect(sideRanks(h).survivor).toEqual([0, 1, 2, 3, -1, -1, -1, -1]);
  });

  it('gives no ranks when the sides are not known', () => {
    const h = header({ sidesKnown: false });
    expect(sideRanks(h)).toEqual({ survivor: Array(8).fill(-1), infected: Array(8).fill(-1) });
  });
});

describe('visibility in frame bytes 6-7', () => {
  it('round-trips the flag and the bits', () => {
    const buf = file(header(), [frame(0b1000_0000_0000_0001)]);
    expect(buf[LOS_FLAG_OFFSET]).toBe(1);
    const r = parseReplay(buf)!;
    expect(r.header.losKnown).toBe(true);
    expect(r.frames[0].los).toBe(0b1000_0000_0000_0001);
  });

  it('reads an existing file (byte 158 zero) as unknown, frames unchanged', () => {
    const h = header({ losKnown: false });
    const buf = file(h, [frame(0)]);
    expect(decodeHeader(buf)!.losKnown).toBe(false);
    const { frames } = decodeFrames(buf, HEADER_BYTES, buf.length);
    expect(frames).toHaveLength(1);
    expect(frames[0].los).toBe(0);
  });

  it('answers canSee from the bit for that survivor and infected rank', () => {
    const h = header();
    // Survivor rank 1 (slot 2) sees infected rank 2 (slot 4): bit 1*4+2 = 6.
    const f = frame(1 << 6);
    expect(canSee(h, f, 2, 4)).toBe(true);
    expect(canSee(h, f, 0, 4)).toBe(false);
    expect(canSee(h, f, 2, 1)).toBe(false);
  });

  it('is null, never false, when the file does not record visibility', () => {
    expect(canSee(header({ losKnown: false }), frame(0xffff), 0, 1)).toBeNull();
  });

  it('is null for a slot that is not on the side asked about', () => {
    expect(canSee(header(), frame(0xffff), 1, 4)).toBeNull();
    expect(canSee(header(), frame(0xffff), 0, 2)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/replayLos.test.ts`
Expected: FAIL, `LOS_FLAG_OFFSET`, `sideRanks` and `canSee` are not exported.

- [ ] **Step 3: Implement**

In `src/replayFormat.ts`:

a) In the `OFF` object, after `sidesFlag: 157,` add:

```ts
  /** 1 when frame bytes 6-7 carry line of sight (see `canSee`). Zero padding
   *  in every file written before 2026-09-23, so those read as "unknown". */
  losFlag: 158,
```

and below `export const SIDES_FLAG_OFFSET ...` add:

```ts
export const LOS_FLAG_OFFSET: number = OFF.losFlag;
```

b) In `interface ReplayHeader`, after `sidesKnown: boolean;` add:

```ts
  /** Whether frames record line of sight in bytes 6-7. False means unknown,
   *  never "nobody saw anything". Optional so hand-built headers need not set
   *  it; `decodeHeader` always does. */
  losKnown?: boolean;
```

c) In `interface Frame`, after `entities: EntitySample[];` add:

```ts
  /** Frame bytes 6-7: bit survivorRank * 4 + infectedRank set when that
   *  survivor could see that spawned infected. Meaningful only when the
   *  header's `losKnown`; read it through `canSee`. */
  los?: number;
```

d) In `encodeHeader`, after the `OFF.sidesFlag` line add:

```ts
  v.setUint8(OFF.losFlag, h.losKnown ? 1 : 0);
```

e) In `decodeHeader`'s returned object, after `sidesKnown: ...,` add:

```ts
    losKnown: v.getUint8(OFF.losFlag) === 1,
```

f) In `encodeFrame`, after `v.setUint16(4, f.entities.length, true);` add:

```ts
  v.setUint16(6, (f.los ?? 0) & 0xffff, true);
```

g) In `decodeFrames`, after `const count = v.getUint16(off + 4, true);` add `const los = v.getUint16(off + 6, true);` and change `frames.push({ tMs, players, entities, offset: off });` to `frames.push({ tMs, players, entities, offset: off, los });`.

h) After `slotInfected`, add:

```ts
/** Each slot's rank on its side, the numbering frame bytes 6-7 use: occupied
 *  slots on each side in slot order, at most four per side. -1 for an empty
 *  slot, a slot on the other side, a fifth player, or unknown sides. */
export function sideRanks(h: Pick<ReplayHeader, 'slots' | 'infectedMask' | 'sidesKnown'>): { survivor: number[]; infected: number[] } {
  const survivor = Array<number>(PLAYER_SLOTS).fill(-1);
  const infected = Array<number>(PLAYER_SLOTS).fill(-1);
  if (!h.sidesKnown) return { survivor, infected };
  let s = 0, i = 0;
  for (let slot = 0; slot < PLAYER_SLOTS; slot++) {
    if (!h.slots[slot]) continue;
    if ((h.infectedMask >> slot) & 1) { if (i < 4) infected[slot] = i++; }
    else if (s < 4) survivor[slot] = s++;
  }
  return { survivor, infected };
}

/** Could this survivor see this spawned infected in this frame. Null when the
 *  file does not record it or a slot has no rank on the side asked about:
 *  unknown is never the same as "could not see". */
export function canSee(h: ReplayHeader, f: Frame, survivorSlot: number, infectedSlot: number): boolean | null {
  if (!h.losKnown) return null;
  const { survivor, infected } = sideRanks(h);
  const sr = survivor[survivorSlot], ir = infected[infectedSlot];
  if (sr === undefined || ir === undefined || sr < 0 || ir < 0) return null;
  return (((f.los ?? 0) >> (sr * 4 + ir)) & 1) === 1;
}
```

- [ ] **Step 4: Run the new tests, then the whole suite and typecheck**

Run: `npx vitest run tests/replayLos.test.ts`
Expected: PASS.

Run: `npx vitest run && npm run typecheck`
Expected: all pass, no type errors. In a fresh worktree `tests/server.test.ts` fails its app-shell test without a web build; that is environmental: run `ln -s /home/volence/l4d/pug/dist dist`, rerun, then `rm dist`.

- [ ] **Step 5: Commit**

```bash
git add src/replayFormat.ts tests/replayLos.test.ts
git commit -m "Read line of sight from replay frame bytes 6-7 and header byte 158"
```

---

### Task 3: Record line of sight in the plugin

**Files:**
- Modify: `plugin/pug-match.sp`
  - version define (line 18)
  - globals near `bool g_bRplSampling;` (line ~326) and `ConVar g_cvReplayStandalone;` (line ~300)
  - cvar creation after `g_cvReplayStandalone = CreateConVar(...)` (line ~450)
  - command registration next to `RegServerCmd("sm_pug_status", ...)` (line ~391)
  - the header writer in the replay open function (the `p = RplU8(p, 1); // 157: mask is filled` line, ~1199)
  - the frame sampler's header patch `RplU16(6, 0);` (~1639)

**Interfaces:**
- Consumes: `g_iPinnedBy[]`, `RplIsGhost(int)`, `slotClient[]` inside the sampler, `rplSlotRoster[]` and `infectedMask` inside the open function, `ZC_*` defines.
- Produces: frame bytes 6-7 and header byte 158 exactly as the Global Constraints define; cvar `sm_pug_replay_los` (default 1); root-only commands `sm_pug_los <viewer> <target>` and `sm_pug_los_bench <count>` for Task 4.

- [ ] **Step 1: Bump the version**

Change `#define PLUGIN_VERSION "0.3.7"` to `#define PLUGIN_VERSION "0.3.8"`. If master is already past 0.3.7 (the balance work), take the next free number and say so in the commit.

- [ ] **Step 2: Add the globals and the cvar**

After `ConVar g_cvReplayStandalone;` add:

```sourcepawn
ConVar g_cvReplayLos;                    // 1 = record survivor-to-infected line of sight in frame bytes 6-7
```

After `bool g_bRplSampling;` add:

```sourcepawn
// Line of sight, fixed per round at replay open (the header flag must match
// every frame). Rank of each slot on its side, the numbering frame bytes 6-7
// use; -1 for none. See src/replayFormat.ts sideRanks, which must agree.
bool g_bRplLos;
int g_iRplSurvRank[RPL_SLOTS];
int g_iRplInfRank[RPL_SLOTS];
```

After the `g_cvReplayStandalone = CreateConVar(...)` statement add:

```sourcepawn
	g_cvReplayLos = CreateConVar("sm_pug_replay_los", "1",
		"1 = record which spawned infected each survivor could see, in every replay frame. Read at round start.",
		FCVAR_NOTIFY, true, 0.0, true, 1.0);
```

- [ ] **Step 3: Write the header flag and the ranks at replay open**

Replace:

```sourcepawn
	p = RplU8(p, infectedMask);                // 156: infected slot mask
	p = RplU8(p, 1);                           // 157: mask is filled
```

with:

```sourcepawn
	p = RplU8(p, infectedMask);                // 156: infected slot mask
	p = RplU8(p, 1);                           // 157: mask is filled

	// Line of sight (158). Ranks follow the mask just written, occupied slots
	// in slot order, four per side at most: exactly what sideRanks() in
	// src/replayFormat.ts computes from the header, so a reader needs nothing
	// but the header to know which bit means which pair.
	g_bRplLos = g_cvReplayLos.BoolValue;
	{
		int ns = 0, ni = 0;
		for (int slot = 0; slot < RPL_SLOTS; slot++)
		{
			g_iRplSurvRank[slot] = -1;
			g_iRplInfRank[slot] = -1;
			if (rplSlotRoster[slot] < 0) continue;
			if (infectedMask & (1 << slot)) { if (ni < 4) g_iRplInfRank[slot] = ni++; }
			else if (ns < 4) g_iRplSurvRank[slot] = ns++;
		}
	}
	p = RplU8(p, g_bRplLos ? 1 : 0);           // 158: frames carry line of sight
```

- [ ] **Step 4: Add the line-of-sight functions**

Directly above the sampler function that contains `RplU16(6, 0);`, add:

```sourcepawn
// ---------- line of sight (frame bytes 6-7) ----------

/** Players never block sight here, and neither do common infected: a common
 *  walking between a survivor and a hunter is not a wall. Everything else the
 *  mask hits does. */
public bool RplLosFilter(int ent, int mask, any viewer)
{
	if (ent >= 1 && ent <= MaxClients) return false;
	if (ent > MaxClients && IsValidEntity(ent))
	{
		char cls[16];
		GetEntityClassname(ent, cls, sizeof(cls));
		if (StrEqual(cls, "infected")) return false;
	}
	return true;
}

bool RplLosClear(const float from[3], const float to[3], int viewer)
{
	// MASK_VISIBLE leaves out CONTENTS_WINDOW and CONTENTS_GRATE, so glass,
	// fences and grates do not block, as they do not block a player's view.
	TR_TraceRayFilter(from, to, MASK_VISIBLE, RayType_EndPoint, RplLosFilter, viewer);
	return !TR_DidHit();
}

/** Visible when any of three points is: eye, chest, feet. Generous on purpose,
 *  so an infected whose head clears a wall counts as seen and aiming at it can
 *  never count as aiming through a wall. */
bool RplCanSee(int viewer, int target)
{
	float eye[3], org[3], pt[3];
	GetClientEyePosition(viewer, eye);
	GetClientEyePosition(target, pt);
	if (RplLosClear(eye, pt, viewer)) return true;
	GetClientAbsOrigin(target, org);
	pt = org; pt[2] += 36.0;
	if (RplLosClear(eye, pt, viewer)) return true;
	pt = org; pt[2] += 8.0;
	return RplLosClear(eye, pt, viewer);
}

bool RplLosViewer(int c)
{
	return IsPlayerAlive(c) && GetClientTeam(c) == TEAM_SURVIVOR
		&& !GetEntProp(c, Prop_Send, "m_isIncapacitated")
		&& !GetEntProp(c, Prop_Send, "m_isHangingFromLedge");
}

bool RplLosTarget(int c)
{
	return IsPlayerAlive(c) && GetClientTeam(c) == TEAM_INFECTED && !RplIsGhost(c)
		&& GetEntProp(c, Prop_Send, "m_zombieClass") != ZC_TANK;
}

/** The 16 bits for one frame. slotClient is the sampler's slot to client map
 *  (0 for an empty slot). */
int RplLosBits(const int[] slotClient)
{
	int bits = 0;
	for (int s = 0; s < RPL_SLOTS; s++)
	{
		int sr = g_iRplSurvRank[s], sc = slotClient[s];
		if (sr < 0 || sc == 0 || !RplLosViewer(sc)) continue;
		for (int i = 0; i < RPL_SLOTS; i++)
		{
			int ir = g_iRplInfRank[i], ic = slotClient[i];
			if (ir < 0 || ic == 0 || !RplLosTarget(ic)) continue;
			if (g_iPinnedBy[sc] == ic) continue;      // pinned: they know where it is
			if (RplCanSee(sc, ic)) bits |= 1 << (sr * 4 + ir);
		}
	}
	return bits;
}
```

If `ZC_TANK` is not defined near `ZC_HUNTER` (line ~31), add `#define ZC_TANK 5` beside the others (5 is the tank's `m_zombieClass` in L4D1, as `ZOMBIE_CLASSES` in `src/replayFormat.ts` also says).

- [ ] **Step 5: Write the bits into each frame**

Replace `	RplU16(6, 0);` in the sampler with:

```sourcepawn
	RplU16(6, g_bRplLos ? RplLosBits(slotClient) : 0);
```

If `slotClient` is not in scope at that point, move the line to just after the player-block loop, where `slotClient` was filled, keeping it before `WriteFile`.

- [ ] **Step 6: Add the two test commands**

Next to `RegServerCmd("sm_pug_status", ...)` add:

```sourcepawn
	RegAdminCmd("sm_pug_los", Cmd_Los, ADMFLAG_ROOT, "sm_pug_los <viewer> <target> - line of sight per point, bots allowed; for testing");
	RegAdminCmd("sm_pug_los_bench", Cmd_LosBench, ADMFLAG_ROOT, "sm_pug_los_bench <count> - time RplCanSee between the first survivor and infected found");
```

and the handlers, below `RplLosBits`:

```sourcepawn
public Action Cmd_Los(int client, int args)
{
	if (args < 2) { ReplyToCommand(client, "usage: sm_pug_los <viewer> <target>"); return Plugin_Handled; }
	char a[64], b[64];
	GetCmdArg(1, a, sizeof(a));
	GetCmdArg(2, b, sizeof(b));
	int v = FindTarget(client, a, false, false), t = FindTarget(client, b, false, false);
	if (v < 1 || t < 1) return Plugin_Handled;
	float eye[3], org[3], pt[3];
	GetClientEyePosition(v, eye);
	GetClientEyePosition(t, pt);
	bool head = RplLosClear(eye, pt, v);
	GetClientAbsOrigin(t, org);
	pt = org; pt[2] += 36.0;
	bool chest = RplLosClear(eye, pt, v);
	pt = org; pt[2] += 8.0;
	bool feet = RplLosClear(eye, pt, v);
	ReplyToCommand(client, "LOS %N -> %N: head=%d chest=%d feet=%d visible=%d dist=%.0f",
		v, t, head, chest, feet, head || chest || feet, GetVectorDistance(eye, org));
	return Plugin_Handled;
}

public Action Cmd_LosBench(int client, int args)
{
	int n = 1000;
	if (args >= 1) { char s[16]; GetCmdArg(1, s, sizeof(s)); n = StringToInt(s); }
	if (n < 1) n = 1;
	int v = 0, t = 0;
	for (int c = 1; c <= MaxClients; c++)
	{
		if (!IsClientInGame(c) || !IsPlayerAlive(c)) continue;
		if (v == 0 && GetClientTeam(c) == TEAM_SURVIVOR) v = c;
		if (t == 0 && GetClientTeam(c) == TEAM_INFECTED && !RplIsGhost(c)) t = c;
	}
	if (v == 0 || t == 0) { ReplyToCommand(client, "need a living survivor and a spawned infected"); return Plugin_Handled; }
	int seen = 0;
	float start = GetEngineTime();
	for (int i = 0; i < n; i++) if (RplCanSee(v, t)) seen++;
	float us = (GetEngineTime() - start) * 1000000.0 / float(n);
	ReplyToCommand(client, "LOSBENCH %N -> %N: %d calls, %.1f us each, visible %d of %d; a full frame is at most 16 calls = %.0f us",
		v, t, n, us, seen, n, us * 16.0);
	return Plugin_Handled;
}
```

- [ ] **Step 7: Build**

Run: `cd plugin && ./build.sh 2>&1 | grep -E "error|warning [0-9]|built"`
Expected: `built: .../plugin/pug-match.smx`, no errors, and no warnings other than the existing `CreateDialog` one from `halflife.inc`.

- [ ] **Step 8: Commit**

```bash
git add plugin/pug-match.sp
git commit -m "pug-match 0.3.8: record survivor-to-infected line of sight in replay frame bytes 6-7"
```

---

### Task 4: Verify on the local test server

The local server at `/home/volence/l4d1-ds` (see its `start-test.sh`, versus, 100 tick, `sv_lan 1`) runs the production plugin set. None of this touches a live server. Bash that starts or talks to it may need `dangerouslyDisableSandbox: true`.

**Files:**
- Create: `scripts/check-replay-los.ts`

**Interfaces:**
- Consumes: `parseReplay`, `sideRanks`, `canSee` from Task 2.
- Produces: a script later tasks and plan 2 use to eyeball a real file.

- [ ] **Step 1: Write the checker script**

```ts
// Print what a replay records about line of sight: whether the file carries
// it, the slot ranks, and per survivor/infected pair how many frames had the
// infected spawned and how many of those it was visible.
//   npx tsx scripts/check-replay-los.ts <file.rpl>
import { readFileSync } from 'node:fs';
import { canSee, parseReplay, sideRanks, STATE } from '../src/replayFormat.js';

const r = parseReplay(readFileSync(process.argv[2]));
if (!r) { console.error('not a replay'); process.exit(1); }
const h = r.header;
console.log(`map ${h.map} half ${h.half} frames ${r.frames.length} losKnown ${h.losKnown}`);
const ranks = sideRanks(h);
console.log('survivor ranks', ranks.survivor.join(','), ' infected ranks', ranks.infected.join(','));
for (let s = 0; s < 8; s++) {
  if (ranks.survivor[s] < 0) continue;
  for (let i = 0; i < 8; i++) {
    if (ranks.infected[i] < 0) continue;
    let spawned = 0, seen = 0;
    for (const f of r.frames) {
      const p = f.players[i];
      if (!p || !(p.state & STATE.ALIVE) || (p.state & STATE.GHOST)) continue;
      spawned++;
      if (canSee(h, f, s, i)) seen++;
    }
    if (spawned) console.log(`slot ${s} -> slot ${i}: visible ${seen} of ${spawned} spawned frames`);
  }
}
```

Run: `npx tsx scripts/check-replay-los.ts /home/volence/l4d1-ds/server/left4dead/replays/$(ls -t /home/volence/l4d1-ds/server/left4dead/replays | head -1)`
Expected: prints `losKnown false` on any existing local file (it predates 0.3.8), and no crash.

- [ ] **Step 2: Install the build locally and check trace correctness with bots**

Copy `plugin/pug-match.smx` into `/home/volence/l4d1-ds/server/left4dead/addons/sourcemod/plugins/`, start the server with `start-test.sh`, then over its rcon (`python3 /home/volence/l4d1-ds/rcon.py '<cmd>'`):

```
sm plugins load_unlock; sm plugins reload pug-match; sm plugins load_lock
sb_all_bot_team 1; sb_add; z_spawn hunter
sm_pug_los Bill Hunter
```

Expected: a `LOS Bill -> Hunter: head=.. chest=.. feet=.. visible=.. dist=..` line. Then move the bots so the answer should flip (`setpos` on the hunter via `sm_pug_los` targets, or `nb_move_to_cursor` from a spectating client) and check three cases, noting each command and answer in the commit message:
1. clear view in the open: `visible=1`;
2. behind a solid wall: `visible=0`;
3. behind a chain-link fence or window on No Mercy 1: `visible=1`. If a fence reads 0, stop and report: spec risk "see-through surfaces not marked see-through" has happened and needs its allowlist before plan 2.

- [ ] **Step 3: Measure the cost**

Run over rcon: `sm_pug_los_bench 5000`
Expected: a `LOSBENCH` line. The frame worst case (`16 calls`) must be under 500 us, 5% of a 10 ms tick, which is invisible at the 10 Hz sample rate. If it is over, reduce `RplCanSee` to eye and chest only and re-measure.

- [ ] **Step 4: Record a real file and decode it**

With the owner (a human on each side; bots do not get roster slots) or with `sm_pug_replay_standalone 1` and two local clients, play one round, then:

Run: `npx tsx scripts/check-replay-los.ts <newest .rpl in the local replays dir>`
Expected: `losKnown true`, ranks matching who played which side, and visible counts that are neither 0 nor equal to spawned for pairs that met. If no human session is possible now, stop here and record that Step 4 is owed: Tasks 2 and 3 are still safe to ship because the format is unchanged, but the first live file must then be checked with this script before plan 2 starts.

- [ ] **Step 5: Commit**

```bash
git add scripts/check-replay-los.ts
git commit -m "Add scripts/check-replay-los.ts, and record the local line-of-sight checks" -m "<paste the three LOS cases, the LOSBENCH line and Step 4's result or 'owed'>"
```

---

### Task 5: Ship

Follow the order in the `pug-audit-hardening` ship notes. The format is unchanged, so web and plugin order does not matter for correctness; web goes first by habit.

- [ ] **Step 1: Re-check for collisions**

Run: `git -C /home/volence/l4d/pug reflog -5 && git -C /home/volence/l4d/pug status --short && git log --oneline master..worktree-balance-analytics -- plugin/pug-match.sp`
If master moved, rebase this branch onto it and rerun `npx vitest run && npm run typecheck && (cd plugin && ./build.sh)`. If balance-analytics has merged, take the next plugin version number.

- [ ] **Step 2: Merge and deploy the web app**

```bash
cd /home/volence/l4d/pug && git merge --ff-only worktree-los-detect
ssh root@45.32.199.85 'sqlite3 /home/pug/app/data/pug.db ".backup /root/pug.db.bak-before-los-$(date -u +%Y%m%dT%H%M)"'
./deploy-web.sh
```

Verify with the recipe in the `pug-deploy-verification` notes: the tree hash on the box equals local, `NRestarts=0`, no errors in `journalctl -u pug-web --since -3min`.

- [ ] **Step 3: Stage the plugin on each server, empty only**

Check first that no match is live: `ssh root@45.32.199.85 'sqlite3 /home/pug/app/data/pug.db "select id from matches where state in (\"live\",\"configuring\")"'` prints nothing.

- Dallas: `cd plugin && ./stage.sh` (refuses if anyone is on).
- Riverside #3 and #4: for each of `l4d1-a` (27015) and `l4d1-b` (27016), confirm `players : 0 humans` over rcon, `scp` the smx to `/tmp`, `install -o l4d -g l4d -m 644` it into `/home/l4d/<inst>/left4dead/addons/sourcemod/plugins/pug-match.smx`, then rcon `sm plugins load_unlock; sm plugins reload pug-match; sm plugins load_lock`. **Never** reload without the unlock: under Rotoblin's load lock a bare reload unloads the plugin and still prints "reloaded successfully".
- Chicago: confirm empty over rcon, upload with `ftplib` as `pug-match.smx.new` into `/left4dead/addons/sourcemod/plugins`, rename over the old file, then the same unlock/reload/lock.
- On every server afterwards: `sm_pug_auto_track 1; sm_pug_roster_at_live 1`, then check `sm plugins info pug-match` shows the new version and `Status: running`, and `sm_pug_replay_los` is `1`.

- [ ] **Step 4: Push and record**

```bash
git -C /home/volence/l4d/pug push origin master:main
git -C /home/volence/l4d/pug push private master:master worktree-los-detect:worktree-los-detect
```

Then note in memory that line-of-sight recording is live, from which UTC time, and that the first real replay still has to be checked with `scripts/check-replay-los.ts` before plan 2 (the analyzer) is written.
