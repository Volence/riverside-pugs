# Balance Control Panel (piece 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admins change curated balance knobs (safe ranges from `balance/knobs.json`) on an admin page; the site announces the change as a patch, writes `cfg/pug_balance.cfg` to every enabled server between matches, and confirms each server when a round is seen running the predicted fingerprint.

**Architecture:** Knob metadata (type, range, step, baseline) lives in `balance/knobs.json` and is validated by `loadBalanceKnobs`. A pure module (`src/balanceControl.ts`) validates a draft, predicts the fingerprint from the latest queue-match patch, and renders the cfg file. `src/balanceRollouts.ts` owns the announced patch and the rollout tables. `src/balanceWriter.ts` writes the file through the existing addons transports (idle boxes on a timer, busy boxes from the server release path), reads it back, and a BALANCE sighting confirms it. A new admin route module and a new Knobs tab expose it.

**Tech Stack:** TypeScript (Node, Fastify, better-sqlite3), Vitest, Preact (web), basic-ftp, ssh/scp.

**Spec:** `docs/superpowers/specs/2026-09-24-balance-control-panel-design.md` (read it, including the planning corrections), parent `docs/superpowers/specs/2026-09-23-balance-analytics-design.md`.

## Global Constraints

- No em dashes anywhere: code, comments, docs, commit messages.
- Every `db` function takes `db: DB` as its first argument; there is no global handle.
- Schema changes go in `openDb` (`src/db.ts`) using `CREATE TABLE IF NOT EXISTS` / `ensureColumn`; no migration framework.
- Every admin route starts with `requireAdmin` and every admin change ends with `logAdmin`.
- Timestamps written by this feature use SQLite's `datetime('now')` format (`YYYY-MM-DD HH:MM:SS`, UTC), as `recordBalanceSighting` does.
- Tests never touch a real server: transports, rcon, restarters are fakes. No ssh, rcon, FTP, sftp or deploy script against a real host, ever.
- The deploy repo (`/home/volence/l4d/deploy`) is read-only for this plan. The hook line is an owner step (see "Owner runbook").
- A parallel branch (piece 5) edits `web/src/routes/admin/AdminPatches.tsx`, `src/routes/admin.ts` and `src/metrics/registry.ts`. Change `AdminPatches.tsx` only where Task 10 says (one cell), do not touch `src/routes/admin.ts` or the metrics registry.
- Test baseline: `npx vitest run` = 1 failed | 4515 passed; the one failure (`tests/server.test.ts` "a malformed URL > gets the app shell on a page path") is pre-existing. `npm run typecheck` must stay clean.

## Knob baseline check (done during planning, 2026-09-24)

Production snapshot (read-only copy, taken 2026-09-24 ~06:30 UTC): the latest tagged queue round is on patch id 6 (detected, fingerprint `26c007403b8d0afa`); servers 1 to 3 are on it, server 4 has no sighting yet. Its `inputs_json` holds exactly these strings for the 16 v1 knobs, identical to the spec table:

```
z_tank_health=8000  z_tank_speed_vs=210  z_witch_damage_per_kill_hit=30  z_pounce_damage=2
z_pounce_damage_interrupt=150  z_vomit_interval=20  tongue_hit_delay=13  tongue_break_from_damage_amount=300
z_mob_spawn_min_size=28  z_mob_spawn_max_size=28  z_mob_spawn_min_interval_normal=30  z_mob_spawn_max_interval_normal=30
l4d_antibaiter_delay=15  rotoblin_limit_smg=3  versus_boss_flow_min=0.10  versus_boss_flow_max=0.90
```

Where the chain sets them today (deploy repo, Dallas state tree): `server_shared_convars.cfg` for all but z_tank_health (`local_4v4.cfg`, 8000, overriding the map cfg's 7000), z_mob_spawn_min/max_size (`rotoblin_pug_4v4_map.cfg`) and l4d_antibaiter_delay (`Reloadables/server_custom_convars.cfg`). All of these run before the end of `rotoblin_pug_4v4_map.cfg`, so the hook line placed last wins. Every range still has to be checked against engine bounds on the rig (Task 11).

Also found: raw `serverDrift` reports Dallas as differing from Chicago and Riverside #3 only by `p:pug-match.smx` (a versionless plugin build). That is why the apply precondition compares fingerprints without knob values instead (spec correction).

## File Structure

- `balance/knobs.json` (modify): 16 cvar entries gain type/min/max/step/baseline (+unit/note/pairMax).
- `src/balanceKnobs.ts` (modify): knob types, validation, value formatting and normalisation.
- `src/addonsTransport.ts` (modify): `readText` on the interface and the three transports; FTP client injectable for tests.
- `src/db.ts` (modify): `balance_rollouts`, `balance_rollout_servers`.
- `src/balanceControl.ts` (create): base inventory, prediction, draft validation, preview, cfg rendering, restore values. Pure plus reads.
- `src/balanceRollouts.ts` (create): apply (announced patch + rollout rows), rollout state transitions, confirmation on sighting, rollout listing.
- `src/balancePatches.ts` (modify): `recordBalanceSighting` takes `expectedPatchId` and stays quiet for it.
- `src/balanceWriter.ts` (create): `BalanceRolloutWriter` (timer, boot verify, release write).
- `src/serverRelease.ts` (modify): optional `beforeRestart` hook.
- `src/routes/adminBalanceKnobs.ts` (create): the five knob endpoints.
- `src/server.ts` (modify): wire writer, releaser hook, sighting confirm, routes.
- `scripts/check-knob-baselines.ts` (create): compare knobs.json baselines with a DB's latest queue patch.
- `web/src/api.ts` (modify), `web/src/routes/admin/balance/knobs.ts` (create), `web/src/routes/admin/balance/Knobs.tsx` (create), `web/src/routes/admin/adminRoutes.ts`, `web/src/routes/Admin.tsx`, `web/src/routes/admin/AdminPatches.tsx` (one cell).
- `plugin/TESTING.md` (modify, Task 11): rig recipe and result for the control panel.

---

### Task 1: Knob metadata and validation

**Files:**
- Modify: `src/balanceKnobs.ts`, `balance/knobs.json`
- Test: `tests/balanceKnobs.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface KnobCvar { cvar: string; label: string; group: string; type?: 'int' | 'float'; min?: number; max?: number;
    step?: number; baseline?: string; unit?: string; note?: string; pairMax?: string }
  export interface AdjustableKnob { cvar: string; label: string; group: string; type: 'int' | 'float'; min: number; max: number;
    step: number; baseline: string; unit?: string; note?: string; pairMax?: string }
  export function isAdjustable(c: KnobCvar): c is KnobCvar & AdjustableKnob
  export function adjustableKnobs(k: BalanceKnobs): AdjustableKnob[]   // knobs.json order
  export function stepDecimals(step: number): number                  // 0.05 -> 2, 250 -> 0
  export function formatKnobValue(k: Pick<AdjustableKnob, 'type' | 'step'>, n: number): string
  export function normalizeKnobValue(k: AdjustableKnob, raw: unknown): { ok: true; value: string } | { ok: false; error: string }
  ```
  `BalanceKnobs.cvars` becomes `KnobCvar[]`.

- [ ] **Step 1: Write the failing tests** (append to `tests/balanceKnobs.test.ts`)

```ts
import { adjustableKnobs, formatKnobValue, loadBalanceKnobs, normalizeKnobValue, stepDecimals, type AdjustableKnob } from '../src/balanceKnobs.js';

const base = { files: [], dirs: [], versionless: [] };
const knob = (over: Record<string, unknown> = {}) => ({
  cvar: 'z_tank_health', label: 'Tank', group: 'tank', type: 'int', min: 6000, max: 10000, step: 250, baseline: '8000', ...over,
});

describe('adjustable knobs', () => {
  it('the shipped knobs.json has the 16 v1 knobs with the live baselines', () => {
    const adj = adjustableKnobs(loadBalanceKnobs());
    expect(adj.map((k) => `${k.cvar}=${k.baseline}`)).toEqual([
      'z_tank_health=8000', 'z_tank_speed_vs=210', 'z_witch_damage_per_kill_hit=30', 'z_pounce_damage=2',
      'z_pounce_damage_interrupt=150', 'z_vomit_interval=20', 'tongue_hit_delay=13', 'tongue_break_from_damage_amount=300',
      'z_mob_spawn_min_size=28', 'z_mob_spawn_max_size=28', 'z_mob_spawn_min_interval_normal=30',
      'z_mob_spawn_max_interval_normal=30', 'l4d_antibaiter_delay=15', 'rotoblin_limit_smg=3',
      'versus_boss_flow_min=0.10', 'versus_boss_flow_max=0.90',
    ]);
  });

  it('a knob without type/range stays watch-only', () => {
    const k = loadBalanceKnobs(undefined, { ...base, cvars: [{ cvar: 'a', label: 'A', group: 'g' }] });
    expect(adjustableKnobs(k)).toEqual([]);
  });

  it('rejects a partial set of range fields', () => {
    expect(() => loadBalanceKnobs(undefined, { ...base, cvars: [knob({ step: undefined })] })).toThrow(/go together/);
  });

  it('rejects a baseline outside the range or off the step grid', () => {
    expect(() => loadBalanceKnobs(undefined, { ...base, cvars: [knob({ baseline: '11000' })] })).toThrow(/baseline/);
    expect(() => loadBalanceKnobs(undefined, { ...base, cvars: [knob({ baseline: '8100' })] })).toThrow(/baseline/);
  });

  it('rejects a max off the grid, a zero step, min over max and a non-integer int range', () => {
    expect(() => loadBalanceKnobs(undefined, { ...base, cvars: [knob({ max: 10100 })] })).toThrow(/max/);
    expect(() => loadBalanceKnobs(undefined, { ...base, cvars: [knob({ step: 0 })] })).toThrow(/step/);
    expect(() => loadBalanceKnobs(undefined, { ...base, cvars: [knob({ min: 11000 })] })).toThrow(/min/);
    expect(() => loadBalanceKnobs(undefined, { ...base, cvars: [knob({ step: 0.5 })] })).toThrow(/whole/);
  });

  it('rejects a float baseline not written with the decimals of step', () => {
    const f = { cvar: 'versus_boss_flow_min', label: 'Flow', group: 'b', type: 'float', min: 0.1, max: 0.3, step: 0.05 };
    expect(() => loadBalanceKnobs(undefined, { ...base, cvars: [{ ...f, baseline: '0.1' }] })).toThrow(/0\.10/);
    expect(() => loadBalanceKnobs(undefined, { ...base, cvars: [{ ...f, baseline: '0.10' }] })).not.toThrow();
  });

  it('rejects a pair that is invalid at baseline or points at a watch-only cvar', () => {
    const lo = knob({ cvar: 'lo', min: 20, max: 34, step: 2, baseline: '30', pairMax: 'hi' });
    const hi = knob({ cvar: 'hi', min: 20, max: 34, step: 2, baseline: '28' });
    expect(() => loadBalanceKnobs(undefined, { ...base, cvars: [lo, hi] })).toThrow(/pair/);
    expect(() => loadBalanceKnobs(undefined, { ...base, cvars: [lo, { cvar: 'hi', label: 'H', group: 'g' }] })).toThrow(/pair/);
  });
});

describe('knob values', () => {
  const tank = knob() as AdjustableKnob;
  const flow = { cvar: 'f', label: 'Flow', group: 'b', type: 'float', min: 0.1, max: 0.3, step: 0.05, baseline: '0.10' } as AdjustableKnob;

  it('formats ints plainly and floats with the decimals of step', () => {
    expect(stepDecimals(0.05)).toBe(2);
    expect(stepDecimals(250)).toBe(0);
    expect(formatKnobValue(tank, 7500)).toBe('7500');
    expect(formatKnobValue(flow, 0.1)).toBe('0.10');
    expect(formatKnobValue(flow, 0.15000000000000002)).toBe('0.15');
  });

  it('normalises numbers and numeric strings to the exact string written', () => {
    expect(normalizeKnobValue(flow, '0.1')).toEqual({ ok: true, value: '0.10' });
    expect(normalizeKnobValue(flow, 0.25)).toEqual({ ok: true, value: '0.25' });
    expect(normalizeKnobValue(tank, '7500')).toEqual({ ok: true, value: '7500' });
  });

  it('refuses out of range, off grid, non-numeric and fractional int values', () => {
    expect(normalizeKnobValue(tank, 5750)).toMatchObject({ ok: false });
    expect(normalizeKnobValue(tank, 7600)).toMatchObject({ ok: false });
    expect(normalizeKnobValue(tank, '8000; quit')).toMatchObject({ ok: false });
    expect(normalizeKnobValue(tank, '7500.5')).toMatchObject({ ok: false });
    expect(normalizeKnobValue(flow, '0.12')).toMatchObject({ ok: false });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/balanceKnobs.test.ts`
Expected: FAIL (`adjustableKnobs` is not exported).

- [ ] **Step 3: Implement in `src/balanceKnobs.ts`**

Replace the `BalanceKnobs.cvars` type and add, after `PATH_RE`:

```ts
export interface KnobCvar {
  cvar: string; label: string; group: string;
  /** Present together (with min, max, step, baseline) on an adjustable knob. */
  type?: 'int' | 'float';
  min?: number; max?: number; step?: number;
  /** The exact string the PUG config chain sets today. */
  baseline?: string;
  unit?: string; note?: string;
  /** A cvar that must stay greater than or equal to this one. */
  pairMax?: string;
}

export interface AdjustableKnob {
  cvar: string; label: string; group: string; type: 'int' | 'float';
  min: number; max: number; step: number; baseline: string;
  unit?: string; note?: string; pairMax?: string;
}

const ADJ_FIELDS = ['type', 'min', 'max', 'step', 'baseline'] as const;

export function isAdjustable(c: KnobCvar): c is KnobCvar & AdjustableKnob {
  return ADJ_FIELDS.every((f) => c[f] !== undefined);
}

export function adjustableKnobs(k: BalanceKnobs): AdjustableKnob[] {
  return k.cvars.filter(isAdjustable);
}

/** Decimals a value of this step is written with: 0.05 -> 2, 250 -> 0. */
export function stepDecimals(step: number): number {
  const s = String(step);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

/** The exact string written to the cfg file and read back by the plugin.
 *  Source keeps the string a cvar was set with, so "0.1" and "0.10" are two
 *  different fingerprints: floats always carry the decimals of their step. */
export function formatKnobValue(k: Pick<AdjustableKnob, 'type' | 'step'>, n: number): string {
  return k.type === 'int' ? String(Math.round(n)) : n.toFixed(stepDecimals(k.step));
}

const onGrid = (k: Pick<AdjustableKnob, 'min' | 'step'>, n: number): boolean => {
  const q = (n - k.min) / k.step;
  return Math.abs(q - Math.round(q)) < 1e-9;
};

/** A draft value as the exact string to write, or why it cannot be written.
 *  Only plain decimal numbers pass, so nothing but a number ever reaches the
 *  cfg file. */
export function normalizeKnobValue(k: AdjustableKnob, raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const s = typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  if (!/^-?\d+(\.\d+)?$/.test(s)) return { ok: false, error: `${k.label}: not a number` };
  const n = Number(s);
  if (k.type === 'int' && !Number.isInteger(n)) return { ok: false, error: `${k.label}: must be a whole number` };
  if (n < k.min - 1e-9 || n > k.max + 1e-9) {
    return { ok: false, error: `${k.label}: ${s} is outside ${formatKnobValue(k, k.min)} to ${formatKnobValue(k, k.max)}` };
  }
  if (!onGrid(k, n)) return { ok: false, error: `${k.label}: must be in steps of ${formatKnobValue(k, k.step)}` };
  return { ok: true, value: formatKnobValue(k, n) };
}

function validateAdjustable(k: BalanceKnobs): void {
  for (const c of k.cvars) {
    const present = ADJ_FIELDS.filter((f) => c[f] !== undefined);
    if (present.length === 0) continue;
    if (present.length !== ADJ_FIELDS.length) throw new Error(`knob ${c.cvar}: type, min, max, step and baseline go together`);
    if (c.type !== 'int' && c.type !== 'float') throw new Error(`knob ${c.cvar}: type must be int or float`);
    for (const f of ['min', 'max', 'step'] as const) {
      if (typeof c[f] !== 'number' || !Number.isFinite(c[f])) throw new Error(`knob ${c.cvar}: ${f} must be a number`);
    }
    const a = c as AdjustableKnob;
    if (!(a.step > 0)) throw new Error(`knob ${c.cvar}: step must be above 0`);
    if (a.min > a.max) throw new Error(`knob ${c.cvar}: min is above max`);
    if (a.type === 'int' && ![a.min, a.max, a.step].every(Number.isInteger)) {
      throw new Error(`knob ${c.cvar}: an int knob needs whole min, max and step`);
    }
    if (!onGrid(a, a.max)) throw new Error(`knob ${c.cvar}: max is not on the step grid`);
    if (typeof a.baseline !== 'string') throw new Error(`knob ${c.cvar}: baseline must be a string`);
    const norm = normalizeKnobValue(a, a.baseline);
    if (!norm.ok) throw new Error(`knob ${c.cvar}: baseline ${norm.error}`);
    if (norm.value !== a.baseline) throw new Error(`knob ${c.cvar}: baseline must be written as ${norm.value}`);
  }
  const adj = new Map(adjustableKnobs(k).map((a) => [a.cvar, a]));
  for (const c of k.cvars) {
    if (c.pairMax === undefined) continue;
    const self = adj.get(c.cvar);
    const other = adj.get(c.pairMax);
    if (!self || !other) throw new Error(`knob ${c.cvar}: pair ${c.pairMax} must be two adjustable knobs`);
    if (Number(self.baseline) > Number(other.baseline)) throw new Error(`knob ${c.cvar}: pair is invalid at baseline`);
  }
}
```

Call `validateAdjustable(k);` in `loadBalanceKnobs` right before `return k;`.

Then edit the 16 entries in `balance/knobs.json` (keep order and every other entry unchanged; one object per line as now):

```json
{ "cvar": "z_tank_health", "label": "Tank base health", "group": "tank", "type": "int", "min": 6000, "max": 10000, "step": 250, "baseline": "8000", "unit": "HP", "note": "Effective HP with versus_tank_bonus_health is unverified in game" },
{ "cvar": "z_tank_speed_vs", "label": "Tank speed (versus)", "group": "tank", "type": "int", "min": 190, "max": 230, "step": 5, "baseline": "210" },
{ "cvar": "z_witch_damage_per_kill_hit", "label": "Witch damage per hit", "group": "witch", "type": "int", "min": 20, "max": 50, "step": 5, "baseline": "30", "unit": "HP" },
{ "cvar": "z_pounce_damage", "label": "Pounce damage", "group": "hunter", "type": "int", "min": 1, "max": 4, "step": 1, "baseline": "2" },
{ "cvar": "z_pounce_damage_interrupt", "label": "Damage to interrupt a pounce", "group": "hunter", "type": "int", "min": 100, "max": 200, "step": 25, "baseline": "150", "note": "Skeet threshold" },
{ "cvar": "z_vomit_interval", "label": "Boomer vomit interval", "group": "boomer", "type": "int", "min": 15, "max": 30, "step": 1, "baseline": "20", "unit": "s" },
{ "cvar": "tongue_hit_delay", "label": "Tongue cooldown", "group": "smoker", "type": "int", "min": 10, "max": 18, "step": 1, "baseline": "13", "unit": "s" },
{ "cvar": "tongue_break_from_damage_amount", "label": "Damage to break a tongue", "group": "smoker", "type": "int", "min": 200, "max": 350, "step": 25, "baseline": "300" },
{ "cvar": "z_mob_spawn_min_size", "label": "Horde min size", "group": "horde", "type": "int", "min": 20, "max": 34, "step": 2, "baseline": "28", "pairMax": "z_mob_spawn_max_size" },
{ "cvar": "z_mob_spawn_max_size", "label": "Horde max size", "group": "horde", "type": "int", "min": 20, "max": 34, "step": 2, "baseline": "28" },
{ "cvar": "z_mob_spawn_min_interval_normal", "label": "Horde min interval", "group": "horde", "type": "int", "min": 20, "max": 45, "step": 5, "baseline": "30", "unit": "s", "pairMax": "z_mob_spawn_max_interval_normal" },
{ "cvar": "z_mob_spawn_max_interval_normal", "label": "Horde max interval", "group": "horde", "type": "int", "min": 20, "max": 45, "step": 5, "baseline": "30", "unit": "s" },
{ "cvar": "l4d_antibaiter_delay", "label": "Anti-bait delay", "group": "horde", "type": "int", "min": 10, "max": 30, "step": 5, "baseline": "15", "unit": "s", "note": "The 9999 off value is not reachable here" },
{ "cvar": "rotoblin_limit_smg", "label": "Uzi limit", "group": "items", "type": "int", "min": 2, "max": 4, "step": 1, "baseline": "3" },
{ "cvar": "versus_boss_flow_min", "label": "Boss flow min", "group": "bosses", "type": "float", "min": 0.1, "max": 0.3, "step": 0.05, "baseline": "0.10", "pairMax": "versus_boss_flow_max" },
{ "cvar": "versus_boss_flow_max", "label": "Boss flow max", "group": "bosses", "type": "float", "min": 0.7, "max": 0.9, "step": 0.05, "baseline": "0.90" },
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/balanceKnobs.test.ts` (the existing include parity test must still pass: the include lists cvar names only) and `npm run typecheck`.
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add balance/knobs.json src/balanceKnobs.ts tests/balanceKnobs.test.ts
git commit -m "balance knobs: types, safe ranges and live baselines for the 16 v1 knobs"
```

---

### Task 2: Transport `readText`

**Files:**
- Modify: `src/addonsTransport.ts`, `tests/fakes/fakeAddonsTransport.ts`, every other object literal typed `AddonsTransport` in `tests/` (find them with `grep -rn "AddonsTransport\|async size(" tests`)
- Test: `tests/addonsTransport.test.ts`

**Interfaces:**
- Produces: `AddonsTransport.readText(remoteName: string): Promise<string | null>` (UTF-8 content, `null` when the file is absent, throws on any other failure). `ftpTransport(cfg)` accepts optional `cfg.client?: () => FtpClientLike`.

- [ ] **Step 1: Write the failing tests** (append to `tests/addonsTransport.test.ts`; add `ftpTransport` to the import)

```ts
describe('readText', () => {
  it('local: reads a file, null when absent', async () => {
    const t = localTransport(dir);
    await t.put(src, 'pug_balance.cfg');
    expect(await t.readText('pug_balance.cfg')).toBe('vpk bytes');
    expect(await t.readText('absent.cfg')).toBeNull();
  });

  it('sftp: cats the file; exit 3 (absent) is null, anything else throws', async () => {
    const calls: string[][] = [];
    const t = sftpTransport({
      host: 'h', port: 22, user: 'l4d', keyPath: '/k', dir: '/cfg',
      run: async (cmd, args) => { calls.push([cmd, ...args]); return { stdout: 'sm_cvar a "1"\n' }; },
    });
    expect(await t.readText('pug_balance.cfg')).toBe('sm_cvar a "1"\n');
    expect(calls[0].join(' ')).toContain("test -e '/cfg/pug_balance.cfg' || exit 3; cat -- '/cfg/pug_balance.cfg'");
    const absent = sftpTransport({ host: 'h', port: 22, user: 'l4d', keyPath: '/k', dir: '/cfg',
      run: async () => { throw Object.assign(new Error('exit 3'), { code: 3 }); } });
    expect(await absent.readText('pug_balance.cfg')).toBeNull();
    const down = sftpTransport({ host: 'h', port: 22, user: 'l4d', keyPath: '/k', dir: '/cfg',
      run: async () => { throw Object.assign(new Error('ssh: connect refused'), { code: 255 }); } });
    await expect(down.readText('pug_balance.cfg')).rejects.toThrow(/refused/);
  });

  it('ftp: downloads the file; 550 is null', async () => {
    const files = new Map([['/cfg/pug_balance.cfg', 'sm_cvar a "1"\n']]);
    let cwd = '/';
    const client = () => ({
      access: async () => ({}), close: () => {}, ensureDir: async () => {}, uploadFrom: async () => ({}),
      rename: async () => ({}), size: async () => 0, remove: async () => ({}),
      cd: async (d: string) => { cwd = d; return {}; },
      downloadTo: async (sink: NodeJS.WritableStream, name: string) => {
        const body = files.get(`${cwd}/${name}`);
        if (body === undefined) throw Object.assign(new Error('550 No such file'), { code: 550 });
        await new Promise<void>((r) => sink.write(Buffer.from(body), () => r()));
        return {};
      },
    });
    const t = ftpTransport({ host: 'h', port: 21, user: 'u', password: 'p', dir: '/cfg', client: client as never });
    expect(await t.readText('pug_balance.cfg')).toBe('sm_cvar a "1"\n');
    expect(await t.readText('absent.cfg')).toBeNull();
  });

  it('refuses an unsafe name', async () => {
    await expect(localTransport(dir).readText('../x')).rejects.toThrow(/name/i);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/addonsTransport.test.ts`
Expected: FAIL (`readText` is not a function / type error).

- [ ] **Step 3: Implement**

In `src/addonsTransport.ts`:
- imports: add `readFile` to the `node:fs/promises` import and `import { Writable } from 'node:stream';`.
- interface: add
  ```ts
  /** The file as UTF-8 text, or null when it is not there. Any other failure
   *  throws, so "could not read" is never mistaken for "absent". Used to read
   *  back small config files after writing them. */
  readText(remoteName: string): Promise<string | null>;
  ```
- `localTransport`:
  ```ts
  async readText(remoteName) {
    assertPlainName(remoteName);
    try {
      return await readFile(join(dir, remoteName), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  },
  ```
- `ftpTransport`: add to cfg `client?: () => FtpClientLike` with
  ```ts
  /** The part of basic-ftp's Client this file uses, so tests can fake it. */
  export type FtpClientLike = Pick<FtpClient, 'access' | 'close' | 'ensureDir' | 'uploadFrom' | 'rename' | 'cd' | 'size' | 'remove' | 'downloadTo'>;
  ```
  and in `withClient` use `const client = cfg.client ? cfg.client() : new FtpClient(30_000);` (type the callback parameter as `FtpClientLike`). Add:
  ```ts
  async readText(remoteName) {
    assertPlainName(remoteName);
    return withClient(async (c) => {
      await c.cd(cfg.dir);
      const chunks: Buffer[] = [];
      const sink = new Writable({ write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); } });
      try {
        await c.downloadTo(sink, remoteName);
      } catch (err) {
        // 550 is FTP's "no such file"; anything else is a real failure.
        if ((err as { code?: number }).code === 550) return null;
        throw err;
      }
      return Buffer.concat(chunks).toString('utf8');
    });
  },
  ```
- `sftpTransport`:
  ```ts
  async readText(remoteName) {
    assertPlainName(remoteName);
    const p = shq(remote(remoteName));
    try {
      // Exit 3 is ours and means absent; ssh itself fails with 255.
      return (await ssh(`test -e ${p} || exit 3; cat -- ${p}`)).stdout;
    } catch (err) {
      if ((err as { code?: number }).code === 3) return null;
      throw err;
    }
  },
  ```
- Test fakes: `tests/fakes/fakeAddonsTransport.ts` gets `const texts = new Map<string, string>();`, `async readText(remoteName) { return texts.get(remoteName) ?? null; }` and returns `texts` alongside `files`; any other inline fake gets `async readText() { return null; }`.

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run tests/addonsTransport.test.ts tests/dlc4.test.ts tests/campaignInstall.test.ts tests/serverAdmins.test.ts tests/campaignRoutes.test.ts` and `npm run typecheck`.
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/addonsTransport.ts tests/
git commit -m "addons transport: readText on local, FTP and sftp, absent is null"
```

---

### Task 3: Rollout tables

**Files:**
- Modify: `src/db.ts` (right after the balance piece 1 block that creates `balance_server_state` and the round tables, before `ensureColumn(db, 'match_rounds', 'patch_id', ...)`), `tests/db.test.ts`
- Test: `tests/balanceSchema.test.ts`

**Interfaces:**
- Produces tables:
  ```sql
  balance_rollouts(id INTEGER PRIMARY KEY, patch_id INTEGER NOT NULL REFERENCES balance_patches(id),
    values_json TEXT NOT NULL, content TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
    superseded_at TEXT)
  balance_rollout_servers(rollout_id INTEGER NOT NULL REFERENCES balance_rollouts(id), server_id INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending','written','confirmed','failed')), last_error TEXT,
    written_at TEXT, confirmed_at TEXT, seen_patch_id INTEGER, seen_at TEXT, PRIMARY KEY (rollout_id, server_id))
  ```

- [ ] **Step 1: Failing test** (append to `tests/balanceSchema.test.ts`, reuse its imports)

```ts
it('creates the rollout tables with a state check', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO balance_patches (id, fingerprint, source, first_seen_at) VALUES (1, 'f', 'announced', '2026-09-24 00:00:00')").run();
  db.prepare("INSERT INTO balance_rollouts (id, patch_id, values_json, content, created_by, created_at) VALUES (1, 1, '{}', 'x', 'a', 'now')").run();
  db.prepare("INSERT INTO balance_rollout_servers (rollout_id, server_id, state) VALUES (1, 1, 'pending')").run();
  expect(() => db.prepare("INSERT INTO balance_rollout_servers (rollout_id, server_id, state) VALUES (1, 2, 'nope')").run()).toThrow();
});
```

- [ ] **Step 2: Run** `npx vitest run tests/balanceSchema.test.ts` and expect FAIL (no such table).

- [ ] **Step 3: Implement** in `src/db.ts`:

```ts
  // Balance analytics piece 4: knob rollouts written to every server.
  // docs/superpowers/specs/2026-09-24-balance-control-panel-design.md
  db.exec(`
    CREATE TABLE IF NOT EXISTS balance_rollouts (
      id            INTEGER PRIMARY KEY,
      patch_id      INTEGER NOT NULL REFERENCES balance_patches(id),
      values_json   TEXT NOT NULL,
      content       TEXT NOT NULL,
      created_by    TEXT NOT NULL,
      created_at    TEXT NOT NULL,
      superseded_at TEXT
    );
    CREATE TABLE IF NOT EXISTS balance_rollout_servers (
      rollout_id    INTEGER NOT NULL REFERENCES balance_rollouts(id),
      server_id     INTEGER NOT NULL,
      state         TEXT NOT NULL CHECK (state IN ('pending','written','confirmed','failed')),
      last_error    TEXT,
      written_at    TEXT,
      confirmed_at  TEXT,
      seen_patch_id INTEGER,
      seen_at       TEXT,
      PRIMARY KEY (rollout_id, server_id)
    );
  `);
```

and add `'balance_rollout_servers', 'balance_rollouts',` to the sorted list in `tests/db.test.ts` (after `'balance_patches'`, before `'balance_server_state'`; keep it sorted exactly as SQLite's `ORDER BY name` returns).

- [ ] **Step 4: Run** `npx vitest run tests/balanceSchema.test.ts tests/db.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db.ts tests/db.test.ts tests/balanceSchema.test.ts
git commit -m "db: balance_rollouts and balance_rollout_servers"
```

---

### Task 4: Prediction, validation and preview (`src/balanceControl.ts`)

**Files:**
- Create: `src/balanceControl.ts`, `scripts/check-knob-baselines.ts`, `tests/balanceFixtures.ts` (shared test fixtures, not a test file)
- Test: `tests/balanceControl.test.ts`

**Interfaces:**
- Consumes: Task 1 (`AdjustableKnob`, `adjustableKnobs`, `normalizeKnobValue`), `fingerprintOf`, `withoutIgnored`, `diffInventories`, `formatDiff` from `src/balancePatches.ts`.
- Produces:
  ```ts
  export type Inventory = Record<string, string>;
  export function baseInventory(db: DB): { patchId: number; inventory: Inventory } | null
  export function currentValues(db: DB, knobs: BalanceKnobs): Record<string, string>
  export function predictInventory(base: Inventory, knobs: BalanceKnobs, values: Record<string, string>): Inventory
  export function missingKnobs(base: Inventory, knobs: BalanceKnobs): string[]
  export function diffIgnoringVersionless(a: Inventory, b: Inventory, versionless: string[]): string
  export function blockingServers(db: DB, base: Inventory, knobs: BalanceKnobs): { serverId: number; name: string; diff: string }[]
  export function validateDraft(knobs: BalanceKnobs, raw: unknown, current: Record<string, string>): { values: Record<string, string>; errors: string[] }
  export function renderBalanceCfg(knobs: BalanceKnobs, values: Record<string, string>, patch: { number: number; name: string | null }): string
  export function patchNumber(db: DB, patchId: number): number
  export interface KnobDiffRow { cvar: string; label: string; group: string; from: string; to: string }
  export interface KnobPreview {
    values: Record<string, string>; errors: string[]; diff: KnobDiffRow[]; groupsChanged: string[];
    base: { patchId: number; number: number } | null; missing: string[];
    blocking: { serverId: number; name: string; diff: string }[];
    fingerprint: string | null;
    existingPatch: { id: number; number: number; name: string | null; notes: string; source: string } | null;
  }
  export function previewKnobs(db: DB, knobs: BalanceKnobs, raw: unknown): KnobPreview
  export function restoreValues(db: DB, knobs: BalanceKnobs, patchId: number):
    { ok: true; values: Record<string, string>; notes: string[] } | { ok: false; error: string }
  ```

- [ ] **Step 1: Write the fixtures and the failing tests**

`tests/balanceFixtures.ts` (imported by Tasks 4, 5 and 9 tests; not named `*.test.ts`, so Vitest does not run it as a suite):

```ts
import type { openDb } from '../src/db.js';
import { recordBalanceSighting } from '../src/balancePatches.js';
import type { BalanceKnobs } from '../src/balanceKnobs.js';

type DB = ReturnType<typeof openDb>;

export const KNOBS: BalanceKnobs = {
  cvars: [
    { cvar: 'z_tank_health', label: 'Tank health', group: 'tank', type: 'int', min: 6000, max: 10000, step: 250, baseline: '8000' },
    { cvar: 'versus_boss_flow_min', label: 'Flow min', group: 'bosses', type: 'float', min: 0.1, max: 0.3, step: 0.05, baseline: '0.10', pairMax: 'versus_boss_flow_max' },
    { cvar: 'versus_boss_flow_max', label: 'Flow max', group: 'bosses', type: 'float', min: 0.1, max: 0.9, step: 0.05, baseline: '0.90' },
    { cvar: 'z_witch_health', label: 'Witch health', group: 'witch' },
  ],
  files: [], dirs: [], versionless: ['pug-match.smx'], ignored: ['l4d_tvwatch.smx'],
};

export const LIVE = {
  'c:z_tank_health': '8000', 'c:versus_boss_flow_min': '0.10', 'c:versus_boss_flow_max': '0.90',
  'c:z_witch_health': '1000', 'p:pug-match.smx': '1.aaaa', 'p:l4d_skypounce.smx': '2.bbbb',
};

/** One queue match on server `serverId` whose round saw `inv`. */
export function sight(db: DB, matchId: number, serverId: number, inv: Record<string, string>, origin = 'queue', at = '2026-09-24 01:00:00') {
  db.prepare("INSERT INTO matches (id, season_id, state, campaign, server_id, token, origin) VALUES (?, 1, 'completed', 'x', ?, ?, ?)")
    .run(matchId, serverId, String(matchId).padStart(32, '0'), origin);
  db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, started_at) VALUES (?, 0, 1, 'a', ?)").run(matchId, at);
  return recordBalanceSighting(db, { matchId, serverId, half: 1, inventory: inv, versionless: KNOBS.versionless, ignored: KNOBS.ignored, now: at });
}
```

`tests/balanceControl.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { addServer } from '../src/serverPool.js';
import { fingerprintOf } from '../src/balancePatches.js';
import {
  baseInventory, blockingServers, currentValues, missingKnobs, predictInventory, previewKnobs,
  renderBalanceCfg, restoreValues, validateDraft,
} from '../src/balanceControl.js';
import { KNOBS, LIVE, sight } from './balanceFixtures.js';

type DB = ReturnType<typeof openDb>;

let db: DB;
let s1: number;
let s2: number;
beforeEach(() => {
  db = openDb(':memory:');
  s1 = addServer(db, { name: 'dallas', host: '10.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
  s2 = addServer(db, { name: 'chicago', host: '10.0.0.2', port: 27015, rconPort: 27015, rconPassword: 'x' });
});

describe('baseInventory', () => {
  it('is the patch of the latest queue round, never an in-game one', () => {
    expect(baseInventory(db)).toBeNull();
    const q = sight(db, 1, s1, LIVE);
    sight(db, 2, s1, { ...LIVE, 'c:z_tank_health': '3480' }, 'in_game', '2026-09-24 02:00:00');
    expect(baseInventory(db)?.patchId).toBe(q.patchId);
    expect(baseInventory(db)?.inventory['c:z_tank_health']).toBe('8000');
  });
});

describe('prediction', () => {
  it('equals the fingerprint of a real sighting with the same values', () => {
    const predicted = predictInventory(LIVE, KNOBS, { z_tank_health: '7500', versus_boss_flow_min: '0.10', versus_boss_flow_max: '0.90' });
    const real = sight(db, 1, s1, { ...LIVE, 'c:z_tank_health': '7500', 'p:pug-match.smx': '9.zzzz', 'p:l4d_tvwatch.smx': '1.1' });
    const fp = db.prepare('SELECT fingerprint FROM balance_patches WHERE id = ?').get(real.patchId) as { fingerprint: string };
    expect(fingerprintOf(predicted, KNOBS.versionless)).toBe(fp.fingerprint);
  });

  it('a changed value changes the fingerprint; "0.1" and "0.10" differ', () => {
    const v = { z_tank_health: '8000', versus_boss_flow_min: '0.10', versus_boss_flow_max: '0.90' };
    const a = fingerprintOf(predictInventory(LIVE, KNOBS, v), KNOBS.versionless);
    expect(a).toBe(fingerprintOf(LIVE, KNOBS.versionless));
    expect(fingerprintOf(predictInventory(LIVE, KNOBS, { ...v, z_tank_health: '7750' }), KNOBS.versionless)).not.toBe(a);
    expect(fingerprintOf(predictInventory(LIVE, KNOBS, { ...v, versus_boss_flow_min: '0.1' }), KNOBS.versionless)).not.toBe(a);
  });

  it('names a knob the servers do not report', () => {
    const { ['c:z_tank_health']: _gone, ...rest } = LIVE;
    expect(missingKnobs({ ...rest, 'x:z_tank_health': 'missing' }, KNOBS)).toEqual(['z_tank_health']);
  });
});

describe('blockingServers', () => {
  it('ignores knob values and versionless builds, reports anything else', () => {
    sight(db, 1, s1, LIVE);
    sight(db, 2, s2, { ...LIVE, 'c:z_tank_health': '7500', 'p:pug-match.smx': '5.ffff' });
    expect(blockingServers(db, LIVE, KNOBS)).toEqual([]);
    sight(db, 3, s2, { ...LIVE, 'p:l4d_itemlimiter.smx': '3.cccc' });
    expect(blockingServers(db, LIVE, KNOBS)).toEqual([{ serverId: s2, name: 'chicago', diff: 'added p:l4d_itemlimiter.smx' }]);
  });

  it('skips a disabled server', () => {
    sight(db, 1, s2, { ...LIVE, 'p:l4d_itemlimiter.smx': '3.cccc' });
    db.prepare('UPDATE servers SET enabled = 0 WHERE id = ?').run(s2);
    expect(blockingServers(db, LIVE, KNOBS)).toEqual([]);
  });
});

describe('validateDraft', () => {
  const cur = { z_tank_health: '8000', versus_boss_flow_min: '0.10', versus_boss_flow_max: '0.90' };
  it('fills missing knobs from current values and normalises', () => {
    expect(validateDraft(KNOBS, { versus_boss_flow_min: 0.15 }, cur)).toEqual({ values: { ...cur, versus_boss_flow_min: '0.15' }, errors: [] });
  });
  it('rejects unknown and watch-only knobs, bad values and a broken pair', () => {
    expect(validateDraft(KNOBS, { z_witch_health: '900' }, cur).errors).toEqual(['z_witch_health is not an adjustable knob']);
    expect(validateDraft(KNOBS, { z_tank_health: '5000' }, cur).errors[0]).toMatch(/outside/);
    expect(validateDraft(KNOBS, { versus_boss_flow_min: '0.30', versus_boss_flow_max: '0.20' }, cur).errors)
      .toEqual(['Flow min must not be above Flow max']);
    expect(validateDraft(KNOBS, 'nope', cur).errors).toEqual(['values must be an object']);
  });
});

describe('renderBalanceCfg', () => {
  it('writes a header and every adjustable knob, quoted, in knobs.json order', () => {
    expect(renderBalanceCfg(KNOBS, { z_tank_health: '7500', versus_boss_flow_min: '0.10', versus_boss_flow_max: '0.90' }, { number: 9, name: 'Tank\n7500' }))
      .toBe([
        '// Generated by riversidepug.com (Admin > Balance > Knobs). Do not edit: the site rewrites this file.',
        '// Values here override the deploy repo. Patch #9 Tank 7500.',
        'sm_cvar z_tank_health "7500"',
        'sm_cvar versus_boss_flow_min "0.10"',
        'sm_cvar versus_boss_flow_max "0.90"',
        '',
      ].join('\n'));
  });
});

describe('previewKnobs', () => {
  it('diffs against current, predicts, and finds the existing patch on a no-op', () => {
    const r = sight(db, 1, s1, LIVE);
    const p = previewKnobs(db, KNOBS, {});
    expect(p.errors).toEqual([]);
    expect(p.diff).toEqual([]);
    expect(p.existingPatch?.id).toBe(r.patchId);
    const q = previewKnobs(db, KNOBS, { z_tank_health: 7500, versus_boss_flow_min: '0.15' });
    expect(q.diff.map((d) => `${d.cvar} ${d.from}->${d.to}`)).toEqual(['z_tank_health 8000->7500', 'versus_boss_flow_min 0.10->0.15']);
    expect(q.groupsChanged).toEqual(['tank', 'bosses']);
    expect(q.existingPatch).toBeNull();
    expect(q.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('has no fingerprint without a base', () => {
    const p = previewKnobs(db, KNOBS, {});
    expect(p.base).toBeNull();
    expect(p.fingerprint).toBeNull();
  });

  it('current values come from the latest rollout, else baselines', () => {
    expect(currentValues(db, KNOBS)).toEqual({ z_tank_health: '8000', versus_boss_flow_min: '0.10', versus_boss_flow_max: '0.90' });
    const r = sight(db, 1, s1, LIVE);
    db.prepare("INSERT INTO balance_rollouts (patch_id, values_json, content, created_by, created_at) VALUES (?, ?, 'x', 'a', 'now')")
      .run(r.patchId, JSON.stringify({ z_tank_health: '7500' }));
    expect(currentValues(db, KNOBS).z_tank_health).toBe('7500');
  });
});

describe('restoreValues', () => {
  it('takes adjustable c: values, keeps current for absent ones, notes ignored knobs', () => {
    const r = sight(db, 1, s1, { ...LIVE, 'c:z_tank_health': '7000' });
    const out = restoreValues(db, KNOBS, r.patchId);
    expect(out).toEqual({ ok: true, values: { z_tank_health: '7000', versus_boss_flow_min: '0.10', versus_boss_flow_max: '0.90' },
      notes: ['Knobs that are not adjustable (1) are left as they are.'] });
  });

  it('refuses a patch with no recorded inputs', () => {
    db.prepare("INSERT INTO balance_patches (id, source, first_seen_at) VALUES (50, 'historical', '2026-01-01 00:00:00')").run();
    expect(restoreValues(db, KNOBS, 50)).toEqual({ ok: false, error: 'This patch has no recorded values (historical patches cannot be restored).' });
  });
});
```

- [ ] **Step 2: Run** `npx vitest run tests/balanceControl.test.ts`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/balanceControl.ts`**

```ts
import type { DB } from './db.js';
import { adjustableKnobs, normalizeKnobValue, type BalanceKnobs } from './balanceKnobs.js';
import { diffInventories, fingerprintOf, formatDiff, withoutIgnored } from './balancePatches.js';

/**
 * The control panel's pure half: what the servers should run and what their
 * fingerprint will be. Nothing here writes. See
 * docs/superpowers/specs/2026-09-24-balance-control-panel-design.md.
 */

export type Inventory = Record<string, string>;

/** The inventory the prediction starts from: the patch on the most recent
 *  round of a queue match. Queue matches always run the pinned PUG config;
 *  balance_server_state may hold a 2v2 or auto-tracked casual inventory. */
export function baseInventory(db: DB): { patchId: number; inventory: Inventory } | null {
  const row = db.prepare(`
    SELECT p.id, p.inputs_json FROM match_rounds r
    JOIN matches m ON m.id = r.match_id
    JOIN balance_patches p ON p.id = r.patch_id
    WHERE m.origin = 'queue' AND p.inputs_json IS NOT NULL
    ORDER BY r.started_at DESC, r.match_id DESC, r.ordinal DESC, r.half DESC
    LIMIT 1`).get() as { id: number; inputs_json: string } | undefined;
  if (!row) return null;
  try {
    return { patchId: row.id, inventory: JSON.parse(row.inputs_json) as Inventory };
  } catch {
    return null;
  }
}

export function patchNumber(db: DB, patchId: number): number {
  const r = db.prepare(`SELECT number FROM (
      SELECT id, ROW_NUMBER() OVER (ORDER BY first_seen_at, id) AS number FROM balance_patches
    ) WHERE id = ?`).get(patchId) as { number: number } | undefined;
  return r?.number ?? 0;
}

/** What the servers are meant to run now: the latest rollout's values over
 *  the baselines (a rollout always holds the full snapshot, the merge only
 *  covers a knob added to knobs.json since). */
export function currentValues(db: DB, knobs: BalanceKnobs): Record<string, string> {
  const out: Record<string, string> = Object.fromEntries(adjustableKnobs(knobs).map((k) => [k.cvar, k.baseline]));
  const row = db.prepare('SELECT values_json FROM balance_rollouts ORDER BY id DESC LIMIT 1').get() as { values_json: string } | undefined;
  if (row) {
    const v = JSON.parse(row.values_json) as Record<string, string>;
    for (const k of Object.keys(out)) if (typeof v[k] === 'string') out[k] = v[k];
  }
  return out;
}

export function predictInventory(base: Inventory, knobs: BalanceKnobs, values: Record<string, string>): Inventory {
  const inv = withoutIgnored(base, knobs.ignored ?? []);
  for (const k of adjustableKnobs(knobs)) inv[`c:${k.cvar}`] = values[k.cvar];
  return inv;
}

export function missingKnobs(base: Inventory, knobs: BalanceKnobs): string[] {
  return adjustableKnobs(knobs).filter((k) => !(`c:${k.cvar}` in base)).map((k) => k.cvar);
}

/** An inventory with ignored plugins and adjustable knob values dropped:
 *  what a rollout cannot change. */
function withoutKnobs(inv: Inventory, knobs: BalanceKnobs): Inventory {
  const out = withoutIgnored(inv, knobs.ignored ?? []);
  for (const k of adjustableKnobs(knobs)) delete out[`c:${k.cvar}`];
  return out;
}

/** formatDiff of a to b, leaving out a versionless plugin whose build alone
 *  changed (its presence still counts, as in the fingerprint). */
export function diffIgnoringVersionless(a: Inventory, b: Inventory, versionless: string[]): string {
  const skip = new Set(versionless.map((f) => `p:${f}`));
  const d = diffInventories(a, b);
  return formatDiff({ ...d, changed: d.changed.filter((c) => !skip.has(c.key)) });
}

/** Enabled servers whose last inventory differs from the base in something a
 *  rollout does not set. Compared by fingerprint, so a versionless plugin
 *  build or a pending knob value never blocks. A server never sighted does
 *  not block. */
export function blockingServers(db: DB, base: Inventory, knobs: BalanceKnobs): { serverId: number; name: string; diff: string }[] {
  const want = withoutKnobs(base, knobs);
  const wantFp = fingerprintOf(want, knobs.versionless);
  const rows = db.prepare(`SELECT st.server_id, s.name, st.inventory_json FROM balance_server_state st
    JOIN servers s ON s.id = st.server_id WHERE s.enabled = 1 ORDER BY s.id`).all() as
    { server_id: number; name: string; inventory_json: string }[];
  const out: { serverId: number; name: string; diff: string }[] = [];
  for (const r of rows) {
    const have = withoutKnobs(JSON.parse(r.inventory_json) as Inventory, knobs);
    if (fingerprintOf(have, knobs.versionless) === wantFp) continue;
    out.push({ serverId: r.server_id, name: r.name, diff: diffIgnoringVersionless(want, have, knobs.versionless) });
  }
  return out;
}

export function validateDraft(knobs: BalanceKnobs, raw: unknown, current: Record<string, string>): { values: Record<string, string>; errors: string[] } {
  const values = { ...current };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { values, errors: ['values must be an object'] };
  const adj = new Map(adjustableKnobs(knobs).map((k) => [k.cvar, k]));
  const errors: string[] = [];
  for (const [cvar, v] of Object.entries(raw as Record<string, unknown>)) {
    const k = adj.get(cvar);
    if (!k) { errors.push(`${cvar} is not an adjustable knob`); continue; }
    const n = normalizeKnobValue(k, v);
    if (n.ok) values[cvar] = n.value;
    else errors.push(n.error);
  }
  for (const k of adj.values()) {
    if (!k.pairMax) continue;
    const other = adj.get(k.pairMax)!;
    if (Number(values[k.cvar]) > Number(values[other.cvar])) errors.push(`${k.label} must not be above ${other.label}`);
  }
  return { values, errors };
}

export function renderBalanceCfg(knobs: BalanceKnobs, values: Record<string, string>, patch: { number: number; name: string | null }): string {
  const name = (patch.name ?? 'unnamed').replace(/[\r\n]+/g, ' ').trim();
  return [
    '// Generated by riversidepug.com (Admin > Balance > Knobs). Do not edit: the site rewrites this file.',
    `// Values here override the deploy repo. Patch #${patch.number} ${name}.`,
    ...adjustableKnobs(knobs).map((k) => `sm_cvar ${k.cvar} "${values[k.cvar]}"`),
    '',
  ].join('\n');
}

export interface KnobDiffRow { cvar: string; label: string; group: string; from: string; to: string }
export interface KnobPreview {
  values: Record<string, string>;
  errors: string[];
  diff: KnobDiffRow[];
  groupsChanged: string[];
  base: { patchId: number; number: number } | null;
  missing: string[];
  blocking: { serverId: number; name: string; diff: string }[];
  fingerprint: string | null;
  existingPatch: { id: number; number: number; name: string | null; notes: string; source: string } | null;
}

export function previewKnobs(db: DB, knobs: BalanceKnobs, raw: unknown): KnobPreview {
  const current = currentValues(db, knobs);
  const { values, errors } = validateDraft(knobs, raw, current);
  const diff = adjustableKnobs(knobs).filter((k) => values[k.cvar] !== current[k.cvar])
    .map((k) => ({ cvar: k.cvar, label: k.label, group: k.group, from: current[k.cvar], to: values[k.cvar] }));
  const groupsChanged = [...new Set(diff.map((d) => d.group))];
  const base = baseInventory(db);
  const missing = base ? missingKnobs(base.inventory, knobs) : [];
  const blocking = base ? blockingServers(db, base.inventory, knobs) : [];
  let fingerprint: string | null = null;
  let existingPatch: KnobPreview['existingPatch'] = null;
  if (base && errors.length === 0 && missing.length === 0) {
    fingerprint = fingerprintOf(predictInventory(base.inventory, knobs, values), knobs.versionless);
    const p = db.prepare('SELECT id, name, notes, source FROM balance_patches WHERE fingerprint = ?').get(fingerprint) as
      { id: number; name: string | null; notes: string; source: string } | undefined;
    if (p) existingPatch = { ...p, number: patchNumber(db, p.id) };
  }
  return {
    values, errors, diff, groupsChanged, missing, blocking, fingerprint, existingPatch,
    base: base ? { patchId: base.patchId, number: patchNumber(db, base.patchId) } : null,
  };
}

export function restoreValues(db: DB, knobs: BalanceKnobs, patchId: number):
  { ok: true; values: Record<string, string>; notes: string[] } | { ok: false; error: string } {
  const row = db.prepare('SELECT inputs_json FROM balance_patches WHERE id = ?').get(patchId) as { inputs_json: string | null } | undefined;
  if (!row) return { ok: false, error: 'No such patch.' };
  if (!row.inputs_json) return { ok: false, error: 'This patch has no recorded values (historical patches cannot be restored).' };
  const inv = JSON.parse(row.inputs_json) as Inventory;
  const values = currentValues(db, knobs);
  const notes: string[] = [];
  const adj = adjustableKnobs(knobs);
  const absent: string[] = [];
  for (const k of adj) {
    const v = inv[`c:${k.cvar}`];
    if (v === undefined) { absent.push(k.label); continue; }
    const n = normalizeKnobValue(k, v);
    if (!n.ok || n.value !== v) return { ok: false, error: `${k.label} was ${v} in that patch, which the panel cannot write (outside the safe range or not in its steps).` };
    values[k.cvar] = v;
  }
  if (absent.length) notes.push(`Not recorded in that patch, kept as now: ${absent.join(', ')}.`);
  const adjSet = new Set(adj.map((k) => `c:${k.cvar}`));
  const other = Object.keys(inv).filter((key) => key.startsWith('c:') && !adjSet.has(key)).length;
  if (other > 0) notes.push(`Knobs that are not adjustable (${other}) are left as they are.`);
  return { ok: true, values, notes };
}
```

And `scripts/check-knob-baselines.ts` (run with `npx tsx scripts/check-knob-baselines.ts <db>`; read-only):

```ts
// Compare every adjustable knob's baseline with the live value on the latest
// queue-match patch in a database (a production snapshot). Read-only.
import Database from 'better-sqlite3';
import { adjustableKnobs, loadBalanceKnobs } from '../src/balanceKnobs.js';
import { baseInventory } from '../src/balanceControl.js';
import type { DB } from '../src/db.js';

const path = process.argv[2];
if (!path) { console.error('usage: check-knob-baselines.ts <db>'); process.exit(2); }
const db = new Database(path, { readonly: true, fileMustExist: true }) as unknown as DB;
const base = baseInventory(db);
if (!base) { console.error('no tagged queue round in this database'); process.exit(2); }
let bad = 0;
for (const k of adjustableKnobs(loadBalanceKnobs())) {
  const live = base.inventory[`c:${k.cvar}`];
  const ok = live === k.baseline;
  if (!ok) bad++;
  console.log(`${ok ? 'OK      ' : 'MISMATCH'} ${k.cvar} baseline=${k.baseline} live=${live ?? '(absent)'}`);
}
console.log(`patch id ${base.patchId}: ${bad === 0 ? 'all baselines match' : `${bad} mismatch(es)`}`);
process.exit(bad === 0 ? 0 : 1);
```

- [ ] **Step 4: Run** `npx vitest run tests/balanceControl.test.ts`, `npm run typecheck`, and the script against the snapshot: `npx tsx scripts/check-knob-baselines.ts /tmp/claude-1000/-home-volence-l4d-pug--claude-worktrees-balance-analytics/3e832127-52cd-4c84-a9a0-2448a4714250/scratchpad/prod.db`. Expected: PASS, clean, `patch id 6: all baselines match`. Record the script output in the task report.

- [ ] **Step 5: Commit**

```bash
git add src/balanceControl.ts scripts/check-knob-baselines.ts tests/balanceControl.test.ts tests/balanceFixtures.ts
git commit -m "balance control: draft validation, fingerprint prediction, preview, cfg rendering, restore"
```

---

### Task 5: Apply and rollout state (`src/balanceRollouts.ts`)

**Files:**
- Create: `src/balanceRollouts.ts`
- Test: `tests/balanceRollouts.test.ts`

**Interfaces:**
- Consumes: Task 4 (`previewKnobs`, `renderBalanceCfg`, `patchNumber`, `diffIgnoringVersionless`, `Inventory`), Task 3 tables.
- Produces:
  ```ts
  export type ApplyResult = { ok: true; rolloutId: number; patchId: number; reused: boolean; preview: KnobPreview }
    | { ok: false; status: 400 | 409; error: string; preview?: KnobPreview };
  export function applyKnobs(db: DB, knobs: BalanceKnobs, req: { values: unknown; name: unknown; notes: unknown; adminId: string; now?: string }): ApplyResult
  export interface RolloutRow { id: number; patch_id: number; values_json: string; content: string; created_by: string; created_at: string; superseded_at: string | null }
  export function activeRollout(db: DB): RolloutRow | null
  export function ensureServerRows(db: DB, rolloutId: number): void
  export function markWritten(db: DB, rolloutId: number, serverId: number, now?: string): void
  export function markFailed(db: DB, rolloutId: number, serverId: number, error: string): boolean  // true on the first failure since the last success
  export function markPending(db: DB, rolloutId: number, serverId: number, reason: string): void
  export function expectedPatchFor(db: DB, serverId: number): number | null
  export function confirmOnSighting(db: DB, s: { serverId: number; patchId: number; now?: string }): void
  export interface RolloutServer { serverId: number; name: string; state: 'pending' | 'written' | 'confirmed' | 'failed';
    lastError: string | null; writtenAt: string | null; confirmedAt: string | null;
    seen: { patchId: number; number: number; at: string } | null; mismatch: string | null }
  export interface RolloutSummary { id: number; patchId: number; patchNumber: number; patchName: string | null;
    values: Record<string, string>; createdBy: string; createdByName: string | null; createdAt: string; supersededAt: string | null; servers: RolloutServer[] }
  export function listRollouts(db: DB, knobs: BalanceKnobs, limit?: number): RolloutSummary[]
  ```

Rules (from the spec): applies are serialized and a new one supersedes the old; the announced patch is created before any write; a reused patch keeps source and name, the typed name and notes only fill an empty name / empty notes; name 1 to 60 chars, notes 1 to 2000 chars when creating; a row per enabled server; `confirmOnSighting` confirms only a row in `written` (sticky once confirmed) and always records the latest sighting in `seen_*` after the write.

- [ ] **Step 1: Write the failing tests** `tests/balanceRollouts.test.ts`

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { addServer } from '../src/serverPool.js';
import { KNOBS, LIVE, sight } from './balanceFixtures.js';
import {
  activeRollout, applyKnobs, confirmOnSighting, ensureServerRows, expectedPatchFor, listRollouts, markFailed, markWritten,
} from '../src/balanceRollouts.js';

type DB = ReturnType<typeof openDb>;
let db: DB;
let s1: number;
let s2: number;
const ADMIN = '76561198000000009';
beforeEach(() => {
  db = openDb(':memory:');
  s1 = addServer(db, { name: 'dallas', host: '10.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
  s2 = addServer(db, { name: 'chicago', host: '10.0.0.2', port: 27015, rconPort: 27015, rconPassword: 'x' });
  sight(db, 1, s1, LIVE);
});

const apply = (values: unknown, name: unknown = 'Tank 7500', notes: unknown = 'testing lower tank HP') =>
  applyKnobs(db, KNOBS, { values, name, notes, adminId: ADMIN, now: '2026-09-24 10:00:00' });

describe('applyKnobs', () => {
  it('creates an announced patch with the predicted inventory, then a rollout with a row per enabled server', () => {
    db.prepare('UPDATE servers SET enabled = 0 WHERE id = ?').run(s2);
    const r = apply({ z_tank_health: 7500 });
    if (!r.ok) throw new Error(r.error);
    expect(r.reused).toBe(false);
    const p = db.prepare('SELECT source, name, notes, first_seen_at, fingerprint, inputs_json FROM balance_patches WHERE id = ?').get(r.patchId) as Record<string, string>;
    expect(p).toMatchObject({ source: 'announced', name: 'Tank 7500', notes: 'testing lower tank HP', first_seen_at: '2026-09-24 10:00:00' });
    expect(p.fingerprint).toBe(r.preview.fingerprint);
    expect(JSON.parse(p.inputs_json)['c:z_tank_health']).toBe('7500');
    const ro = activeRollout(db)!;
    expect(ro.content).toContain('sm_cvar z_tank_health "7500"');
    expect(ro.content).toContain('Patch #2 Tank 7500.');
    expect(db.prepare('SELECT server_id, state FROM balance_rollout_servers').all()).toEqual([{ server_id: s1, state: 'pending' }]);
  });

  it('requires a name and notes for a new patch', () => {
    expect(apply({ z_tank_health: 7500 }, '')).toMatchObject({ ok: false, status: 400 });
    expect(apply({ z_tank_health: 7500 }, 'x'.repeat(61))).toMatchObject({ ok: false, status: 400 });
    expect(apply({ z_tank_health: 7500 }, 'ok', '')).toMatchObject({ ok: false, status: 400 });
  });

  it('refuses invalid values, no base, missing knobs and a server that differs in more than knob values', () => {
    expect(apply({ z_tank_health: 1 })).toMatchObject({ ok: false, status: 400 });
    const empty = openDb(':memory:');
    expect(applyKnobs(empty, KNOBS, { values: {}, name: 'n', notes: 'n', adminId: ADMIN })).toMatchObject({ ok: false, status: 409 });
    sight(db, 2, s2, { ...LIVE, 'p:l4d_itemlimiter.smx': '1.1' }, 'in_game');
    expect(apply({ z_tank_health: 7500 })).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/chicago/) });
  });

  it('reuses an existing patch on a no-op, keeping its source, filling an empty name only', () => {
    const r = apply({}, 'Current config', 'baseline check');
    if (!r.ok) throw new Error(r.error);
    expect(r.reused).toBe(true);
    expect(db.prepare('SELECT source, name, notes FROM balance_patches WHERE id = ?').get(r.patchId))
      .toEqual({ source: 'detected', name: 'Current config', notes: 'baseline check' });
    const again = apply({}, 'Other name', 'other notes');
    if (!again.ok) throw new Error(again.error);
    expect(db.prepare('SELECT name, notes FROM balance_patches WHERE id = ?').get(r.patchId)).toEqual({ name: 'Current config', notes: 'baseline check' });
  });

  it('a reused named patch needs no typed name', () => {
    expect(apply({}, 'Named', 'n').ok).toBe(true);
    expect(apply({}, '', '').ok).toBe(true);
  });

  it('a new rollout supersedes the previous one', () => {
    const a = apply({ z_tank_health: 7500 });
    const b = apply({ z_tank_health: 7750 }, 'Tank 7750', 'n');
    if (!a.ok || !b.ok) throw new Error('apply failed');
    expect(activeRollout(db)!.id).toBe(b.rolloutId);
    expect(db.prepare('SELECT superseded_at FROM balance_rollouts WHERE id = ?').get(a.rolloutId)).toEqual({ superseded_at: '2026-09-24 10:00:00' });
  });
});

describe('rollout state', () => {
  it('ensureServerRows adds a pending row for a server enabled later', () => {
    db.prepare('UPDATE servers SET enabled = 0 WHERE id = ?').run(s2);
    const r = apply({ z_tank_health: 7500 });
    if (!r.ok) throw new Error(r.error);
    db.prepare('UPDATE servers SET enabled = 1 WHERE id = ?').run(s2);
    ensureServerRows(db, r.rolloutId);
    expect(db.prepare('SELECT server_id, state FROM balance_rollout_servers ORDER BY server_id').all())
      .toEqual([{ server_id: s1, state: 'pending' }, { server_id: s2, state: 'pending' }]);
  });

  it('confirms a written server on a sighting of the expected patch, records a mismatch otherwise', () => {
    const r = apply({ z_tank_health: 7500 });
    if (!r.ok) throw new Error(r.error);
    expect(expectedPatchFor(db, s1)).toBe(r.patchId);
    confirmOnSighting(db, { serverId: s1, patchId: r.patchId, now: '2026-09-24 10:01:00' });
    expect(db.prepare('SELECT state FROM balance_rollout_servers WHERE server_id = ?').get(s1)).toEqual({ state: 'pending' });
    markWritten(db, r.rolloutId, s1, '2026-09-24 10:02:00');
    const other = sight(db, 3, s1, { ...LIVE, 'c:z_tank_health': '7000' }, 'queue', '2026-09-24 10:03:00');
    confirmOnSighting(db, { serverId: s1, patchId: other.patchId, now: '2026-09-24 10:03:00' });
    let row = listRollouts(db, KNOBS)[0].servers.find((s) => s.serverId === s1)!;
    expect(row.state).toBe('written');
    expect(row.mismatch).toBe('c:z_tank_health 7500 -> 7000');
    confirmOnSighting(db, { serverId: s1, patchId: r.patchId, now: '2026-09-24 10:04:00' });
    row = listRollouts(db, KNOBS)[0].servers.find((s) => s.serverId === s1)!;
    expect(row).toMatchObject({ state: 'confirmed', confirmedAt: '2026-09-24 10:04:00', mismatch: null });
  });

  it('markFailed reports only the first failure since the last success', () => {
    const r = apply({ z_tank_health: 7500 });
    if (!r.ok) throw new Error(r.error);
    expect(markFailed(db, r.rolloutId, s1, 'refused')).toBe(true);
    expect(markFailed(db, r.rolloutId, s1, 'refused')).toBe(false);
    expect(listRollouts(db, KNOBS)[0].servers.find((s) => s.serverId === s1)).toMatchObject({ state: 'failed', lastError: 'refused' });
  });

  it('no rollout means no expectation', () => {
    expect(expectedPatchFor(db, s1)).toBeNull();
  });
});
```

- [ ] **Step 2: Run** `npx vitest run tests/balanceRollouts.test.ts`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/balanceRollouts.ts`**

```ts
import type { DB } from './db.js';
import type { BalanceKnobs } from './balanceKnobs.js';
import {
  diffIgnoringVersionless, patchNumber, predictInventory, previewKnobs, renderBalanceCfg, type Inventory, type KnobPreview,
} from './balanceControl.js';

/** SQLite's datetime('now') format, so it sorts against the other balance times. */
const sqlNow = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

export type ApplyResult = { ok: true; rolloutId: number; patchId: number; reused: boolean; preview: KnobPreview }
  | { ok: false; status: 400 | 409; error: string; preview?: KnobPreview };

export interface RolloutRow {
  id: number; patch_id: number; values_json: string; content: string; created_by: string; created_at: string; superseded_at: string | null;
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Announce the patch, then open a rollout for every enabled server. One
 *  transaction, so a rollout never exists without its patch and two applies
 *  cannot interleave. Writing to the boxes is the writer's job. */
export function applyKnobs(db: DB, knobs: BalanceKnobs, req: {
  values: unknown; name: unknown; notes: unknown; adminId: string; now?: string;
}): ApplyResult {
  const now = req.now ?? sqlNow();
  return db.transaction((): ApplyResult => {
    const preview = previewKnobs(db, knobs, req.values);
    if (preview.errors.length) return { ok: false, status: 400, error: preview.errors.join('; '), preview };
    if (!preview.base) return { ok: false, status: 409, error: 'No queue match has been seen with a balance fingerprint yet, so there is nothing to predict from.', preview };
    if (preview.missing.length) return { ok: false, status: 409, error: `Not reported by the servers: ${preview.missing.join(', ')}.`, preview };
    if (preview.blocking.length) {
      return { ok: false, status: 409, preview,
        error: `Servers differ in more than knob values: ${preview.blocking.map((b) => `${b.name} (${b.diff})`).join('; ')}. Disable a server or fix it first.` };
    }
    const name = text(req.name);
    const notes = typeof req.notes === 'string' ? req.notes.trim() : '';
    if (name.length > 60) return { ok: false, status: 400, error: 'A patch name is up to 60 characters.', preview };
    if (notes.length > 2000) return { ok: false, status: 400, error: 'Notes are up to 2000 characters.', preview };

    let patchId: number;
    const reused = preview.existingPatch !== null;
    if (preview.existingPatch) {
      const p = preview.existingPatch;
      patchId = p.id;
      if (!p.name) {
        if (!name) return { ok: false, status: 400, error: 'This config is an unnamed patch: give it a name.', preview };
        db.prepare('UPDATE balance_patches SET name = ? WHERE id = ?').run(name, patchId);
      }
      if (!p.notes && notes) db.prepare('UPDATE balance_patches SET notes = ? WHERE id = ?').run(notes, patchId);
    } else {
      if (!name) return { ok: false, status: 400, error: 'A new patch needs a name.', preview };
      if (!notes) return { ok: false, status: 400, error: 'A new patch needs notes saying what changed and why.', preview };
      const base = db.prepare('SELECT inputs_json FROM balance_patches WHERE id = ?').get(preview.base.patchId) as { inputs_json: string };
      const inv = predictInventory(JSON.parse(base.inputs_json) as Inventory, knobs, preview.values);
      const invJson = JSON.stringify(Object.fromEntries(Object.entries(inv).sort()));
      patchId = Number(db.prepare(`INSERT INTO balance_patches (fingerprint, name, notes, source, inputs_json, first_seen_at, reviewed)
        VALUES (?, ?, ?, 'announced', ?, ?, 1)`).run(preview.fingerprint, name, notes, invJson, now).lastInsertRowid);
    }
    const patchName = (db.prepare('SELECT name FROM balance_patches WHERE id = ?').get(patchId) as { name: string | null }).name;
    const content = renderBalanceCfg(knobs, preview.values, { number: patchNumber(db, patchId), name: patchName });
    db.prepare('UPDATE balance_rollouts SET superseded_at = ? WHERE superseded_at IS NULL').run(now);
    const rolloutId = Number(db.prepare(`INSERT INTO balance_rollouts (patch_id, values_json, content, created_by, created_at)
      VALUES (?, ?, ?, ?, ?)`).run(patchId, JSON.stringify(preview.values), content, req.adminId, now).lastInsertRowid);
    ensureServerRows(db, rolloutId);
    return { ok: true, rolloutId, patchId, reused, preview };
  })();
}

export function activeRollout(db: DB): RolloutRow | null {
  return (db.prepare('SELECT * FROM balance_rollouts WHERE superseded_at IS NULL ORDER BY id DESC LIMIT 1').get() as RolloutRow | undefined) ?? null;
}

/** A pending row for every enabled server that has none, so a box enabled
 *  after the apply still gets the file. */
export function ensureServerRows(db: DB, rolloutId: number): void {
  db.prepare(`INSERT OR IGNORE INTO balance_rollout_servers (rollout_id, server_id, state)
    SELECT ?, id, 'pending' FROM servers WHERE enabled = 1`).run(rolloutId);
}

export function markWritten(db: DB, rolloutId: number, serverId: number, now: string = sqlNow()): void {
  db.prepare(`UPDATE balance_rollout_servers SET state = 'written', written_at = ?, last_error = NULL
    WHERE rollout_id = ? AND server_id = ? AND state IN ('pending', 'failed')`).run(now, rolloutId, serverId);
}

/** True when this is the first failure since the row was last pending or
 *  written, so the caller alerts once rather than on every retry. */
export function markFailed(db: DB, rolloutId: number, serverId: number, error: string): boolean {
  const prev = db.prepare('SELECT state FROM balance_rollout_servers WHERE rollout_id = ? AND server_id = ?')
    .get(rolloutId, serverId) as { state: string } | undefined;
  db.prepare("UPDATE balance_rollout_servers SET state = 'failed', last_error = ? WHERE rollout_id = ? AND server_id = ?")
    .run(error.slice(0, 500), rolloutId, serverId);
  return prev !== undefined && prev.state !== 'failed';
}

/** Back to pending, for a box whose file no longer matches (boot check). */
export function markPending(db: DB, rolloutId: number, serverId: number, reason: string): void {
  db.prepare(`UPDATE balance_rollout_servers SET state = 'pending', last_error = ?, written_at = NULL, confirmed_at = NULL
    WHERE rollout_id = ? AND server_id = ?`).run(reason, rolloutId, serverId);
}

/** The patch a sighting from this server is expected to carry, so the
 *  "config changed" alert stays quiet for the change the panel made. */
export function expectedPatchFor(db: DB, serverId: number): number | null {
  const r = db.prepare(`SELECT ro.patch_id FROM balance_rollouts ro
    JOIN balance_rollout_servers rs ON rs.rollout_id = ro.id AND rs.server_id = ?
    WHERE ro.superseded_at IS NULL ORDER BY ro.id DESC LIMIT 1`).get(serverId) as { patch_id: number } | undefined;
  return r?.patch_id ?? null;
}

/** A BALANCE sighting from this server: confirm the active rollout's row when
 *  the file is written and the patch is the expected one; always remember
 *  what was seen after the write, for "expected X, saw Y". */
export function confirmOnSighting(db: DB, s: { serverId: number; patchId: number; now?: string }): void {
  const now = s.now ?? sqlNow();
  const ro = activeRollout(db);
  if (!ro) return;
  const row = db.prepare('SELECT state FROM balance_rollout_servers WHERE rollout_id = ? AND server_id = ?')
    .get(ro.id, s.serverId) as { state: string } | undefined;
  if (!row || (row.state !== 'written' && row.state !== 'confirmed')) return;
  db.prepare('UPDATE balance_rollout_servers SET seen_patch_id = ?, seen_at = ? WHERE rollout_id = ? AND server_id = ?')
    .run(s.patchId, now, ro.id, s.serverId);
  if (row.state === 'written' && s.patchId === ro.patch_id) {
    db.prepare("UPDATE balance_rollout_servers SET state = 'confirmed', confirmed_at = ? WHERE rollout_id = ? AND server_id = ?")
      .run(now, ro.id, s.serverId);
  }
}

export interface RolloutServer {
  serverId: number; name: string; state: 'pending' | 'written' | 'confirmed' | 'failed';
  lastError: string | null; writtenAt: string | null; confirmedAt: string | null;
  seen: { patchId: number; number: number; at: string } | null;
  /** What the last sighting differed in, when it was not the expected patch. */
  mismatch: string | null;
}
export interface RolloutSummary {
  id: number; patchId: number; patchNumber: number; patchName: string | null; values: Record<string, string>;
  createdBy: string; createdByName: string | null; createdAt: string; supersededAt: string | null; servers: RolloutServer[];
}

export function listRollouts(db: DB, knobs: BalanceKnobs, limit = 20): RolloutSummary[] {
  const rows = db.prepare(`SELECT ro.*, p.name AS patch_name, pl.name AS admin_name FROM balance_rollouts ro
    JOIN balance_patches p ON p.id = ro.patch_id LEFT JOIN players pl ON pl.steamid = ro.created_by
    ORDER BY ro.id DESC LIMIT ?`).all(limit) as (RolloutRow & { patch_name: string | null; admin_name: string | null })[];
  const inputsOf = (id: number): Inventory | null => {
    const r = db.prepare('SELECT inputs_json FROM balance_patches WHERE id = ?').get(id) as { inputs_json: string | null } | undefined;
    return r?.inputs_json ? (JSON.parse(r.inputs_json) as Inventory) : null;
  };
  return rows.map((ro) => {
    const servers = db.prepare(`SELECT rs.*, s.name FROM balance_rollout_servers rs JOIN servers s ON s.id = rs.server_id
      WHERE rs.rollout_id = ? ORDER BY s.id`).all(ro.id) as {
        server_id: number; name: string; state: RolloutServer['state']; last_error: string | null; written_at: string | null;
        confirmed_at: string | null; seen_patch_id: number | null; seen_at: string | null }[];
    const expected = inputsOf(ro.patch_id);
    return {
      id: ro.id, patchId: ro.patch_id, patchNumber: patchNumber(db, ro.patch_id), patchName: ro.patch_name,
      values: JSON.parse(ro.values_json) as Record<string, string>, createdBy: ro.created_by, createdByName: ro.admin_name,
      createdAt: ro.created_at, supersededAt: ro.superseded_at,
      servers: servers.map((s) => {
        const seen = s.seen_patch_id !== null && s.seen_at !== null
          ? { patchId: s.seen_patch_id, number: patchNumber(db, s.seen_patch_id), at: s.seen_at } : null;
        const seenInv = seen && seen.patchId !== ro.patch_id ? inputsOf(seen.patchId) : null;
        return {
          serverId: s.server_id, name: s.name, state: s.state, lastError: s.last_error, writtenAt: s.written_at,
          confirmedAt: s.confirmed_at, seen,
          mismatch: seen && seen.patchId !== ro.patch_id
            ? (expected && seenInv ? diffIgnoringVersionless(expected, seenInv, knobs.versionless) : 'a different patch')
            : null,
        };
      }),
    };
  });
}
```

- [ ] **Step 4: Run** `npx vitest run tests/balanceRollouts.test.ts tests/balanceControl.test.ts` and `npm run typecheck`. Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/balanceRollouts.ts tests/balanceRollouts.test.ts
git commit -m "balance rollouts: announced patch before any write, rollout rows, confirmation on sighting"
```

---

### Task 6: Quiet, confirming sightings

**Files:**
- Modify: `src/balancePatches.ts` (`recordBalanceSighting`), `src/server.ts` (the `balance_end` branch, around line 961)
- Test: `tests/balancePatches.test.ts`, `tests/balanceWiring.test.ts`

**Interfaces:**
- Consumes: Task 5 `expectedPatchFor`, `confirmOnSighting`.
- Produces: `recordBalanceSighting(db, { ..., expectedPatchId?: number | null })`: when the sighting's patch equals `expectedPatchId`, the server state is still updated but no `problem` event is published.

- [ ] **Step 1: Failing tests**

In `tests/balancePatches.test.ts` (reuse its setup and its way of capturing admin events; it already subscribes to the admin feed for the alert tests, copy that pattern):

```ts
it('stays quiet for the patch a rollout expects on that server', () => {
  // server 1 seen on inventory A, then on B which is the expected patch
  const a = recordBalanceSighting(db, { matchId: 1, serverId: 1, half: 1, inventory: { 'c:a': '1' }, versionless: [] });
  expect(a.serverChanged).toBe(true);
  const events: string[] = [];
  const off = subscribeAdminEvents((e) => { if (e.kind === 'problem') events.push(e.text); });
  db.prepare("INSERT INTO balance_patches (id, fingerprint, source, inputs_json, first_seen_at) VALUES (99, ?, 'announced', '{\"c:a\":\"2\"}', '2026-09-24 00:00:00')")
    .run(fingerprintOf({ 'c:a': '2' }, []));
  const b = recordBalanceSighting(db, { matchId: 1, serverId: 1, half: 1, inventory: { 'c:a': '2' }, versionless: [], expectedPatchId: 99 });
  off();
  expect(b).toMatchObject({ patchId: 99, serverChanged: true, newPatch: false });
  expect(events).toEqual([]);
  expect(db.prepare('SELECT patch_id FROM balance_server_state WHERE server_id = 1').get()).toEqual({ patch_id: 99 });
});
```

(Adjust the `matches`/`match_rounds` seed to whatever that file's `beforeEach` already provides; import `subscribeAdminEvents` from `../src/adminFeed.js` and `fingerprintOf` if not already imported.)

In `tests/balanceWiring.test.ts` add:

```ts
it('a sighting of the rollout patch confirms the written server', async () => {
  const port = await freeUdpPort();
  const db = openDb(':memory:');
  const sid = addServer(db, { name: 'dallas', host: '127.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
  db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
  db.prepare("INSERT INTO matches (id, season_id, state, campaign, server_id, token) VALUES (1, 1, 'live', 'x', ?, ?)").run(sid, T);
  db.prepare("INSERT INTO match_live (match_id, current_map, last_seen) VALUES (1, 'm', datetime('now'))").run();
  const knobs = loadBalanceKnobs();
  const inv = { 'c:z_tank_health': '7500' };
  const fp = fingerprintOf(withoutIgnored(inv, knobs.ignored ?? []), knobs.versionless);
  db.prepare("INSERT INTO balance_patches (id, fingerprint, source, inputs_json, first_seen_at) VALUES (5, ?, 'announced', ?, '2026-09-24 00:00:00')")
    .run(fp, JSON.stringify(inv));
  db.prepare("INSERT INTO balance_rollouts (id, patch_id, values_json, content, created_by, created_at) VALUES (1, 5, '{}', 'x', 'a', 'now')").run();
  db.prepare("INSERT INTO balance_rollout_servers (rollout_id, server_id, state, written_at) VALUES (1, ?, 'written', 'now')").run(sid);
  const app = await buildServer({ config: { ...loadConfig({}), devMode: false, logListenPort: port }, db,
    serverCleaner: async () => {}, serverExec: async () => {} });
  close = () => app.close();

  await send(port, `PUG ${T} ROUND_START map=m half=1 surv=a`);
  await settle();
  await send(port, `PUG ${T} BALANCE half=1 part=0 c:z_tank_health=7500`);
  await send(port, `PUG ${T} BALANCE_END half=1 parts=1 items=1`);
  await settle();

  expect(db.prepare('SELECT state FROM balance_rollout_servers WHERE rollout_id = 1').get()).toEqual({ state: 'confirmed' });
});
```

Note: from Task 8 on, `buildServer` in non-dev mode also starts the balance writer; this test passes `serverCleaner`/`serverExec` fakes and the writer has no transport configured for a server without `addons_dir` (it reports and skips), so nothing is dialled. If Task 8 lands first, also pass `balanceTransport: () => null`.

- [ ] **Step 2: Run** `npx vitest run tests/balancePatches.test.ts tests/balanceWiring.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement**

In `recordBalanceSighting`'s parameter type add `expectedPatchId?: number | null;` with a doc comment ("The patch a control panel rollout expects on this server: its first sighting is the change the panel made, so it updates the state without an alert."). In the `if (!prev || prevJson !== invJson)` block, keep the state upsert and wrap only the patch-number query and `publishAdminEvent` in `if (s.expectedPatchId == null || patchId !== s.expectedPatchId) { ... }`.

In `src/server.ts`, import `expectedPatchFor, confirmOnSighting` from `./balanceRollouts.js` and change the `balance_end` branch to:

```ts
            const serverId = m.server_id ?? serverOf(source, meta);
            const r = recordBalanceSighting(deps.db, {
              matchId: m.id, serverId, half: ev.half,
              inventory: inv, versionless: balanceKnobs.versionless, ignored: balanceKnobs.ignored,
              expectedPatchId: serverId !== null ? expectedPatchFor(deps.db, serverId) : null,
            });
            if (serverId !== null) confirmOnSighting(deps.db, { serverId, patchId: r.patchId });
            return;
```

- [ ] **Step 4: Run** `npx vitest run tests/balancePatches.test.ts tests/balanceWiring.test.ts tests/balanceAdmin.test.ts` and `npm run typecheck`. Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/balancePatches.ts src/server.ts tests/balancePatches.test.ts tests/balanceWiring.test.ts
git commit -m "balance sightings: confirm rollouts, no config-changed alert for the expected patch"
```

---

### Task 7: The writer (`src/balanceWriter.ts`)

**Files:**
- Create: `src/balanceWriter.ts`
- Test: `tests/balanceWriter.test.ts`

**Interfaces:**
- Consumes: Task 2 `readText`, Task 5 `activeRollout`, `ensureServerRows`, `markWritten`, `markFailed`, `markPending`, `listServers`/`getServer` from `src/serverPool.ts`, `transportFor`.
- Produces:
  ```ts
  export const BALANCE_CFG = 'pug_balance.cfg';
  export function cfgDirOf(server: ServerRow): string | null
  export interface WriteOutcome { serverId: number; server: string; ok: boolean; skipped?: string; error?: string }
  export class BalanceRolloutWriter {
    constructor(deps: { db: DB; transport?: (s: ServerRow, dir: string) => AddonsTransport | null; intervalMs?: number; timeoutMs?: number })
    sync(): Promise<WriteOutcome[]>              // idle enabled boxes with a pending/failed row
    verifyAll(): Promise<WriteOutcome[]>         // boot: read back every enabled box of the active rollout, then sync
    writeForRelease(serverId: number): Promise<void>  // release path: ignores status, never rejects
    start(): void; stop(): void
  }
  ```

Behaviour:
- Every public method runs on one promise chain (as `ServerAdminSync` does), so two writes to one box never overlap and an apply during a pass is picked up by the next pass.
- A write: render nothing (content comes from `rollout.content`), write it to a temp local file, `transport.put(local, BALANCE_CFG)`, then `transport.readText(BALANCE_CFG)`; equal bytes -> `markWritten`, else `markFailed('read-back differs from what was written')`. Only marks rows of the rollout that is still active when the write finishes.
- A failure publishes one admin `problem` ("Could not write the balance config to <server>: <error>. It is retried every minute.") when `markFailed` returns true.
- No transport (no `addons_dir`, or half-configured) -> `markFailed('no addons transport configured')`, same alert rule.
- `sync()` writes only `status === 'idle'` enabled servers; others are `skipped: 'busy'`.
- `verifyAll()` for each enabled server with a row: read back; equal and row `pending`/`failed` -> `markWritten`; different and row `written`/`confirmed` -> `markPending('the file on the box differs from the rollout')`; unreadable -> leave as is. Then `sync()`.
- Each transport call pair is bounded by `timeoutMs` (default 60 s): a hung FTP never wedges the chain.
- `start()` runs `sync()` every `intervalMs` (default 60 s), timer `unref()`ed.

- [ ] **Step 1: Failing tests** `tests/balanceWriter.test.ts`

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { addServer, getServer, markLive, type ServerRow } from '../src/serverPool.js';
import type { AddonsTransport } from '../src/addonsTransport.js';
import { subscribeAdminEvents } from '../src/adminFeed.js';
import { BalanceRolloutWriter, cfgDirOf } from '../src/balanceWriter.js';
import { readFileSync } from 'node:fs';

type DB = ReturnType<typeof openDb>;

/** An in-memory cfg dir per server; `corrupt` makes read-back return other bytes. */
function fakeBoxes() {
  const disk = new Map<string, string>();
  const opts = { fail: new Set<number>(), corrupt: new Set<number>(), dirs: [] as string[] };
  const transport = (s: ServerRow, dir: string): AddonsTransport => {
    opts.dirs.push(dir);
    return {
      async put(local, name) {
        if (opts.fail.has(s.id)) throw new Error('connection refused');
        disk.set(`${s.id}/${name}`, readFileSync(local, 'utf8'));
      },
      async readText(name) {
        const v = disk.get(`${s.id}/${name}`);
        return v === undefined ? null : opts.corrupt.has(s.id) ? `${v}junk` : v;
      },
      async size() { return null; },
      async remove() {},
    };
  };
  return { disk, opts, transport };
}

let db: DB;
let s1: number;
let s2: number;
beforeEach(() => {
  db = openDb(':memory:');
  s1 = addServer(db, { name: 'dallas', host: '10.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
  s2 = addServer(db, { name: 'chicago', host: '10.0.0.2', port: 27015, rconPort: 27015, rconPassword: 'x' });
  db.prepare("UPDATE servers SET status = 'idle', addons_dir = '/g/left4dead/addons'").run();
  db.prepare("INSERT INTO balance_patches (id, fingerprint, source, first_seen_at) VALUES (1, 'f', 'announced', 'now')").run();
  db.prepare("INSERT INTO balance_rollouts (id, patch_id, values_json, content, created_by, created_at) VALUES (1, 1, '{}', 'CONTENT', 'a', 'now')").run();
  db.prepare("INSERT INTO balance_rollout_servers (rollout_id, server_id, state) VALUES (1, ?, 'pending'), (1, ?, 'pending')").run(s1, s2);
});
const state = (sid: number) => (db.prepare('SELECT state, last_error FROM balance_rollout_servers WHERE server_id = ?').get(sid) as { state: string; last_error: string | null });

describe('cfgDirOf', () => {
  it('replaces the addons segment with cfg', () => {
    expect(cfgDirOf({ addons_dir: '/left4dead/addons' } as never)).toBe('/left4dead/cfg');
    expect(cfgDirOf({ addons_dir: '/home/l4d/l4d1-a/left4dead/addons/' } as never)).toBe('/home/l4d/l4d1-a/left4dead/cfg');
    expect(cfgDirOf({ addons_dir: null } as never)).toBeNull();
    expect(cfgDirOf({ addons_dir: '/weird' } as never)).toBeNull();
  });
});

describe('BalanceRolloutWriter', () => {
  it('writes idle boxes, reads back, and marks them written', async () => {
    const f = fakeBoxes();
    const w = new BalanceRolloutWriter({ db, transport: f.transport });
    await w.sync();
    expect(f.disk.get(`${s1}/pug_balance.cfg`)).toBe('CONTENT');
    expect(f.opts.dirs[0]).toBe('/g/left4dead/cfg');
    expect(state(s1).state).toBe('written');
    expect(state(s2).state).toBe('written');
  });

  it('defers a live box, and the release path writes it regardless of status', async () => {
    const f = fakeBoxes();
    markLive(db, s2);
    const w = new BalanceRolloutWriter({ db, transport: f.transport });
    const out = await w.sync();
    expect(out.find((o) => o.serverId === s2)?.skipped).toBe('busy');
    expect(state(s2).state).toBe('pending');
    await w.writeForRelease(s2);
    expect(state(s2).state).toBe('written');
  });

  it('a failed write is failed with its error, alerts once, and is retried', async () => {
    const f = fakeBoxes();
    f.opts.fail.add(s1);
    const alerts: string[] = [];
    const off = subscribeAdminEvents((e) => { if (e.kind === 'problem') alerts.push(e.text); });
    const w = new BalanceRolloutWriter({ db, transport: f.transport });
    await w.sync();
    await w.sync();
    off();
    expect(state(s1)).toEqual({ state: 'failed', last_error: 'connection refused' });
    expect(alerts.length).toBe(1);
    f.opts.fail.clear();
    await w.sync();
    expect(state(s1).state).toBe('written');
  });

  it('a read-back that differs is a failure', async () => {
    const f = fakeBoxes();
    f.opts.corrupt.add(s1);
    await new BalanceRolloutWriter({ db, transport: f.transport }).sync();
    expect(state(s1)).toEqual({ state: 'failed', last_error: 'read-back differs from what was written' });
  });

  it('boot verify: a matching file marks written, a changed file goes back to pending and is rewritten', async () => {
    const f = fakeBoxes();
    f.disk.set(`${s1}/pug_balance.cfg`, 'CONTENT');
    f.disk.set(`${s2}/pug_balance.cfg`, 'OLD');
    db.prepare("UPDATE balance_rollout_servers SET state = 'confirmed' WHERE server_id = ?").run(s2);
    markLive(db, s2);
    await new BalanceRolloutWriter({ db, transport: f.transport }).verifyAll();
    expect(state(s1).state).toBe('written');
    expect(state(s2)).toEqual({ state: 'pending', last_error: 'the file on the box differs from the rollout' });
  });

  it('a server with no transport is failed, not skipped silently', async () => {
    db.prepare('UPDATE servers SET addons_dir = NULL WHERE id = ?').run(s1);
    await new BalanceRolloutWriter({ db, transport: fakeBoxes().transport }).sync();
    expect(state(s1)).toEqual({ state: 'failed', last_error: 'no addons transport configured' });
  });

  it('adds rows for servers enabled after the apply and skips disabled ones', async () => {
    const s3 = addServer(db, { name: 'r3', host: '10.0.0.3', port: 27015, rconPort: 27015, rconPassword: 'x' });
    db.prepare("UPDATE servers SET status = 'idle', addons_dir = '/g/left4dead/addons' WHERE id = ?").run(s3);
    db.prepare('UPDATE servers SET enabled = 0 WHERE id = ?').run(s2);
    await new BalanceRolloutWriter({ db, transport: fakeBoxes().transport }).sync();
    expect(state(s3).state).toBe('written');
    expect(state(s2).state).toBe('pending');
  });

  it('does nothing without an active rollout', async () => {
    db.prepare("UPDATE balance_rollouts SET superseded_at = 'x'").run();
    expect(await new BalanceRolloutWriter({ db, transport: fakeBoxes().transport }).sync()).toEqual([]);
  });

  it('a hung transport times out instead of wedging the chain', async () => {
    const hung = (): AddonsTransport => ({ put: () => new Promise(() => {}), readText: async () => null, size: async () => null, remove: async () => {} });
    const w = new BalanceRolloutWriter({ db, transport: hung, timeoutMs: 20 });
    await w.sync();
    expect(state(s1)).toEqual({ state: 'failed', last_error: 'timed out after 20 ms' });
  });
});

// getServer is imported to keep the ServerRow import used by type-only checks.
void getServer;
```

- [ ] **Step 2: Run** `npx vitest run tests/balanceWriter.test.ts`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/balanceWriter.ts`**

```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DB } from './db.js';
import { transportFor, type AddonsTransport } from './addonsTransport.js';
import { getServer, listServers, type ServerRow } from './serverPool.js';
import { publishAdminEvent } from './adminFeed.js';
import { activeRollout, ensureServerRows, markFailed, markPending, markWritten, type RolloutRow } from './balanceRollouts.js';

/**
 * Puts the active rollout's cfg/pug_balance.cfg on every enabled server.
 *
 * Idle boxes are written on a timer; a reserved or live box waits for the
 * release path (writeForRelease), which runs after the rcon cleanup and
 * before the after-match restart, so a match never changes config halfway.
 * "Written" means the bytes read back equal what was sent.
 */

export const BALANCE_CFG = 'pug_balance.cfg';
const SWEEP_MS = 60_000;
const TIMEOUT_MS = 60_000;

/** `<game>/left4dead/addons` -> `<game>/left4dead/cfg`; null for a layout we
 *  cannot reason about, which then reads as "no transport". */
export function cfgDirOf(server: ServerRow): string | null {
  const dir = (server as ServerRow & { addons_dir?: string | null }).addons_dir;
  if (!dir) return null;
  const m = /^(.*)\/addons\/?$/.exec(dir);
  return m ? `${m[1]}/cfg` : null;
}

export interface WriteOutcome { serverId: number; server: string; ok: boolean; skipped?: string; error?: string }

export class BalanceRolloutWriter {
  private chain: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private deps: {
    db: DB;
    /** Injected so tests never touch a filesystem or a network. */
    transport?: (s: ServerRow, dir: string) => AddonsTransport | null;
    intervalMs?: number;
    timeoutMs?: number;
  }) {}

  private queue<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    const next = this.chain.then(fn).catch((err) => {
      console.error('[balanceWriter] pass failed:', err);
      return fallback;
    });
    this.chain = next;
    return next;
  }

  sync(): Promise<WriteOutcome[]> {
    return this.queue(() => this.pass(false), []);
  }

  verifyAll(): Promise<WriteOutcome[]> {
    return this.queue(async () => {
      await this.verify();
      return this.pass(false);
    }, []);
  }

  /** Never rejects: the release path must free the box whatever happens here. */
  async writeForRelease(serverId: number): Promise<void> {
    await this.queue(async () => {
      const ro = activeRollout(this.deps.db);
      const server = getServer(this.deps.db, serverId);
      if (!ro || !server || server.enabled !== 1) return;
      ensureServerRows(this.deps.db, ro.id);
      if (this.needsWrite(ro.id, serverId)) await this.writeOne(server, ro);
    }, undefined);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sync(), this.deps.intervalMs ?? SWEEP_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private needsWrite(rolloutId: number, serverId: number): boolean {
    const r = this.deps.db.prepare('SELECT state FROM balance_rollout_servers WHERE rollout_id = ? AND server_id = ?')
      .get(rolloutId, serverId) as { state: string } | undefined;
    return r?.state === 'pending' || r?.state === 'failed';
  }

  private async pass(_boot: boolean): Promise<WriteOutcome[]> {
    const ro = activeRollout(this.deps.db);
    if (!ro) return [];
    ensureServerRows(this.deps.db, ro.id);
    const out: WriteOutcome[] = [];
    for (const s of listServers(this.deps.db).filter((x) => x.enabled === 1)) {
      if (!this.needsWrite(ro.id, s.id)) continue;
      if (s.status !== 'idle') { out.push({ serverId: s.id, server: s.name, ok: false, skipped: 'busy' }); continue; }
      out.push(await this.writeOne(s, ro));
    }
    return out;
  }

  private transportOf(server: ServerRow): AddonsTransport | null {
    const dir = cfgDirOf(server);
    return dir ? (this.deps.transport ?? transportFor)(server, dir) : null;
  }

  private bounded<T>(p: Promise<T>): Promise<T> {
    const ms = this.deps.timeoutMs ?? TIMEOUT_MS;
    let t: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { t = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms); });
    return Promise.race([p, timeout]).finally(() => clearTimeout(t));
  }

  private async writeOne(server: ServerRow, ro: RolloutRow): Promise<WriteOutcome> {
    const base = { serverId: server.id, server: server.name };
    const t = this.transportOf(server);
    if (!t) return this.fail(server, ro, 'no addons transport configured');
    const dir = await mkdtemp(join(tmpdir(), 'pug-balance-'));
    try {
      const local = join(dir, BALANCE_CFG);
      await writeFile(local, ro.content, 'utf8');
      const back = await this.bounded((async () => {
        await t.put(local, BALANCE_CFG);
        return t.readText(BALANCE_CFG);
      })());
      if (back !== ro.content) return this.fail(server, ro, 'read-back differs from what was written');
      // A newer apply may have landed while this one was in flight; its own
      // pass writes the new content, so only the still-active rollout is marked.
      if (activeRollout(this.deps.db)?.id === ro.id) markWritten(this.deps.db, ro.id, server.id);
      return { ...base, ok: true };
    } catch (err) {
      return this.fail(server, ro, err instanceof Error ? err.message : String(err));
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private fail(server: ServerRow, ro: RolloutRow, error: string): WriteOutcome {
    console.error(`[balanceWriter] ${server.name}: ${error}`);
    if (markFailed(this.deps.db, ro.id, server.id, error)) {
      publishAdminEvent({ kind: 'problem', text: `Could not write the balance config to ${server.name}: ${error}. It is retried every minute; see Admin > Balance > Knobs.` });
    }
    return { serverId: server.id, server: server.name, ok: false, error };
  }

  private async verify(): Promise<void> {
    const ro = activeRollout(this.deps.db);
    if (!ro) return;
    ensureServerRows(this.deps.db, ro.id);
    for (const s of listServers(this.deps.db).filter((x) => x.enabled === 1)) {
      const t = this.transportOf(s);
      if (!t) continue;
      let text: string | null;
      try {
        text = await this.bounded(t.readText(BALANCE_CFG));
      } catch (err) {
        console.error(`[balanceWriter] boot read-back on ${s.name} failed:`, err);
        continue;
      }
      const row = this.deps.db.prepare('SELECT state FROM balance_rollout_servers WHERE rollout_id = ? AND server_id = ?')
        .get(ro.id, s.id) as { state: string } | undefined;
      if (!row) continue;
      if (text === ro.content && (row.state === 'pending' || row.state === 'failed')) markWritten(this.deps.db, ro.id, s.id);
      if (text !== ro.content && (row.state === 'written' || row.state === 'confirmed')) {
        markPending(this.deps.db, ro.id, s.id, 'the file on the box differs from the rollout');
      }
    }
  }
}
```

(`pass` takes an unused `_boot` flag only if the implementer needs it; drop the parameter if lint or review objects.)

- [ ] **Step 4: Run** `npx vitest run tests/balanceWriter.test.ts` and `npm run typecheck`. Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/balanceWriter.ts tests/balanceWriter.test.ts
git commit -m "balance writer: write pug_balance.cfg to idle boxes, read back, boot verify, release write"
```

---

### Task 8: Release hook and server wiring

**Files:**
- Modify: `src/serverRelease.ts`, `src/server.ts`
- Test: `tests/serverRelease.test.ts`, `tests/balanceWriterWiring.test.ts` (create)

**Interfaces:**
- Consumes: Task 7 `BalanceRolloutWriter`.
- Produces: `new ServerReleaser(db, cleaner, restarter?, beforeRestart?: (server: ServerRow) => Promise<void>)`; `ServerDeps.balanceTransport?: (s: ServerRow, dir: string) => AddonsTransport | null`; a `balanceWriter` built in `buildServer`, started (with `verifyAll()` at boot) only when `!deps.config.devMode`, stopped on close, released boxes written through it.

- [ ] **Step 1: Failing tests**

`tests/serverRelease.test.ts`, inside `describe('ServerReleaser')` (uses that file's `seedServer`, `markLive`):

```ts
  it('runs the before-restart hook after the cleanup and before the restart', async () => {
    const db = openDb(':memory:');
    const id = seedServer(db);
    markLive(db, id);
    db.prepare('UPDATE servers SET restart_after_match = 1 WHERE id = ?').run(id);
    const order: string[] = [];
    const restarter = { restart: async () => { order.push('restart'); return true; } };
    const releaser = new ServerReleaser(db, async () => { order.push('clean'); }, restarter as never,
      async (s) => { order.push(`hook:${s.id}`); });
    releaser.release(id, { restart: true });
    await releaser.settled();
    expect(order).toEqual(['clean', `hook:${id}`, 'restart']);
    expect(getServer(db, id)!.status).toBe('idle');
  });

  it('a hook that throws still restarts and frees the box', async () => {
    const db = openDb(':memory:');
    const id = seedServer(db);
    markLive(db, id);
    const releaser = new ServerReleaser(db, async () => {}, null, async () => { throw new Error('ftp down'); });
    releaser.release(id);
    await releaser.settled();
    expect(getServer(db, id)!.status).toBe('idle');
  });
```

(Check `ServerRestarter`'s real shape in `src/serverRestart.ts` and build the fake to match it instead of `as never` if it has more members.)

`tests/balanceWriterWiring.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { openDb } from '../src/db.js';
import { buildServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { addServer } from '../src/serverPool.js';
import type { AddonsTransport } from '../src/addonsTransport.js';

describe('balance writer wiring', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => { await close?.(); });

  it('verifies and writes the active rollout at boot through the injected transport', async () => {
    const db = openDb(':memory:');
    const sid = addServer(db, { name: 'dallas', host: '127.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
    db.prepare("UPDATE servers SET status = 'idle', addons_dir = '/g/left4dead/addons' WHERE id = ?").run(sid);
    db.prepare("INSERT INTO balance_patches (id, fingerprint, source, first_seen_at) VALUES (1, 'f', 'announced', 'now')").run();
    db.prepare("INSERT INTO balance_rollouts (id, patch_id, values_json, content, created_by, created_at) VALUES (1, 1, '{}', 'CONTENT', 'a', 'now')").run();
    db.prepare("INSERT INTO balance_rollout_servers (rollout_id, server_id, state) VALUES (1, ?, 'pending')").run(sid);
    const disk = new Map<string, string>();
    const transport = (): AddonsTransport => ({
      put: async (local, name) => { disk.set(name, readFileSync(local, 'utf8')); },
      readText: async (name) => disk.get(name) ?? null, size: async () => null, remove: async () => {},
    });
    const app = await buildServer({ config: { ...loadConfig({}), devMode: false, logListenPort: await freeUdpPort() }, db,
      serverCleaner: async () => {}, serverExec: async () => {}, balanceTransport: transport });
    close = () => app.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(disk.get('pug_balance.cfg')).toBe('CONTENT');
    expect(db.prepare('SELECT state FROM balance_rollout_servers').get()).toEqual({ state: 'written' });
  });
});
```

(Copy `freeUdpPort()` verbatim from `tests/balanceWiring.test.ts`, with its `dgram` and `AddressInfo` imports.)

- [ ] **Step 2: Run** `npx vitest run tests/serverRelease.test.ts tests/balanceWriterWiring.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement**

`src/serverRelease.ts`: add constructor parameter
```ts
    /** Runs after the rcon cleanup and before the restart, for every release.
     *  The balance writer puts a pending pug_balance.cfg here, so the new
     *  values land between matches and the restart loads them. Failures are
     *  logged and never stop the release. */
    private beforeRestart: ((server: ServerRow) => Promise<void>) | null = null,
```
and in `release()` insert a step between the cleanup `.catch` and the restart `.then`:
```ts
      .then(async () => {
        if (!this.beforeRestart) return;
        try {
          await this.beforeRestart(server);
        } catch (err) {
          console.error(`[serverRelease] before-restart step failed on ${server.name}:`, err);
        }
      })
```
(import `type ServerRow` is already there.)

`src/server.ts`:
- import `BalanceRolloutWriter` from `./balanceWriter.js` and `type AddonsTransport` from `./addonsTransport.js`.
- `ServerDeps`: add
  ```ts
  /** Transport the balance writer uses for pug_balance.cfg. Injected in tests
   *  so a rollout never touches a real box; transportFor otherwise. */
  balanceTransport?: (s: ServerRow, dir: string) => AddonsTransport | null;
  ```
- Before `const releaser = new ServerReleaser(...)`: `const balanceWriter = new BalanceRolloutWriter({ db: deps.db, transport: deps.balanceTransport });`
- Pass `(server) => balanceWriter.writeForRelease(server.id)` as the releaser's 4th argument (after `restarter`).
- In the `if (!deps.config.devMode) { banSync.start(); ... }` block add `balanceWriter.start();` and `void balanceWriter.verifyAll();`.
- In the `onClose` hook next to `adminSync.stop();` add `balanceWriter.stop();`.
- Keep `balanceWriter` in scope for Task 9 (route registration).

- [ ] **Step 4: Run** `npx vitest run tests/serverRelease.test.ts tests/balanceWriterWiring.test.ts tests/balanceWiring.test.ts tests/server.test.ts` and `npm run typecheck`. Expected: PASS except the known `tests/server.test.ts` malformed-URL failure; clean.

- [ ] **Step 5: Commit**

```bash
git add src/serverRelease.ts src/server.ts tests/serverRelease.test.ts tests/balanceWriterWiring.test.ts
git commit -m "balance writer: write on release before the restart, boot verify and minute sweep"
```

---

### Task 9: Admin API

**Files:**
- Create: `src/routes/adminBalanceKnobs.ts`
- Modify: `src/server.ts` (register it next to `adminRoutes`)
- Test: `tests/balanceKnobRoutes.test.ts`

**Interfaces:**
- Consumes: Tasks 4, 5, 7.
- Produces HTTP (all `requireAdmin`; 503 `{error}` when knobs failed to load):
  - `GET /api/admin/balance/knobs` -> `{ knobs: KnobView[]; current: Record<string,string>; base: {patchId, number} | null; missing: string[]; blocking: {serverId,name,diff}[]; active: RolloutSummary | null; restorable: {id, number, name, source}[] }` where `KnobView = AdjustableKnob` fields.
  - `POST /api/admin/balance/knobs/preview` body `{values}` -> `KnobPreview`.
  - `POST /api/admin/balance/knobs/apply` body `{values, name, notes}` -> `{ ok: true, rolloutId, patchId, reused }` or `{error, preview?}` with 400/409; audited `logAdmin(db, adminId, 'balance_apply', rolloutId, { patchId, reused, changes: diff })`; then `void writer?.sync()`.
  - `GET /api/admin/balance/knobs/restore/:patchId` -> `{ values, notes }` or 400 `{error}`.
  - `GET /api/admin/balance/rollouts` -> `{ rollouts: RolloutSummary[] }`.

- [ ] **Step 1: Failing tests** `tests/balanceKnobRoutes.test.ts`

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { buildServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { addServer } from '../src/serverPool.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import { KNOBS, LIVE, sight } from './balanceFixtures.js';

const ADMIN = '76561198000000009';

describe('balance knob API', () => {
  let db: ReturnType<typeof openDb>;
  let knobsPath: string;
  beforeEach(() => {
    db = openDb(':memory:');
    const s1 = addServer(db, { name: 'dallas', host: '10.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
    sight(db, 1, s1, LIVE);
    knobsPath = join(mkdtempSync(join(tmpdir(), 'knobs-')), 'knobs.json');
    writeFileSync(knobsPath, JSON.stringify(KNOBS));
  });

  async function app(admin = true) {
    const a = await buildServer({ config: loadConfig({}), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {},
      serverExec: async () => {}, balanceKnobsPath: knobsPath });
    const steamid = admin ? ADMIN : '76561198000000010';
    const cookies = await authedCookie(a, db, steamid);
    if (admin) db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
    return { a, cookies };
  }

  it('lists adjustable knobs with current values, base and restorable patches', async () => {
    const { a, cookies } = await app();
    const res = await a.inject({ method: 'GET', url: '/api/admin/balance/knobs', cookies });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.knobs.map((k: { cvar: string }) => k.cvar)).toEqual(['z_tank_health', 'versus_boss_flow_min', 'versus_boss_flow_max']);
    expect(body.current.z_tank_health).toBe('8000');
    expect(body.base.number).toBe(1);
    expect(body.restorable.length).toBe(1);
    expect(body.active).toBeNull();
  });

  it('previews without writing anything', async () => {
    const { a, cookies } = await app();
    const res = await a.inject({ method: 'POST', url: '/api/admin/balance/knobs/preview', cookies, payload: { values: { z_tank_health: 7500 } } });
    expect(res.json().diff).toEqual([{ cvar: 'z_tank_health', label: 'Tank health', group: 'tank', from: '8000', to: '7500' }]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM balance_rollouts').get()).toEqual({ n: 0 });
  });

  it('applies, audits, and lists the rollout', async () => {
    const { a, cookies } = await app();
    const res = await a.inject({ method: 'POST', url: '/api/admin/balance/knobs/apply', cookies,
      payload: { values: { z_tank_health: 7500 }, name: 'Tank 7500', notes: 'lower tank HP' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, reused: false });
    expect(db.prepare("SELECT COUNT(*) AS n FROM admin_actions WHERE action = 'balance_apply'").get()).toEqual({ n: 1 });
    const list = await a.inject({ method: 'GET', url: '/api/admin/balance/rollouts', cookies });
    expect(list.json().rollouts[0]).toMatchObject({ patchName: 'Tank 7500', servers: [{ name: 'dallas', state: 'pending' }] });
  });

  it('answers 400 with the errors for an invalid draft', async () => {
    const { a, cookies } = await app();
    const res = await a.inject({ method: 'POST', url: '/api/admin/balance/knobs/apply', cookies,
      payload: { values: { z_tank_health: 1 }, name: 'x', notes: 'y' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/outside/);
  });

  it('restores values from a patch', async () => {
    const { a, cookies } = await app();
    const res = await a.inject({ method: 'GET', url: '/api/admin/balance/knobs/restore/1', cookies });
    expect(res.json().values.z_tank_health).toBe('8000');
  });

  it('refuses a non-admin on every route', async () => {
    const { a, cookies } = await app(false);
    for (const [method, url] of [['GET', '/api/admin/balance/knobs'], ['POST', '/api/admin/balance/knobs/preview'],
      ['POST', '/api/admin/balance/knobs/apply'], ['GET', '/api/admin/balance/rollouts'], ['GET', '/api/admin/balance/knobs/restore/1']] as const) {
      expect((await a.inject({ method, url, cookies, payload: method === 'POST' ? {} : undefined })).statusCode).toBe(403);
    }
  });

  it('503 when knobs.json cannot be loaded', async () => {
    writeFileSync(knobsPath, '{');
    const { a, cookies } = await app();
    expect((await a.inject({ method: 'GET', url: '/api/admin/balance/knobs', cookies })).statusCode).toBe(503);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run tests/balanceKnobRoutes.test.ts`. Expected: FAIL (404s).

- [ ] **Step 3: Implement `src/routes/adminBalanceKnobs.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import type { DB } from '../db.js';
import { makeRequireAdmin } from './guards.js';
import { logAdmin } from '../admin/audit.js';
import { adjustableKnobs, type BalanceKnobs } from '../balanceKnobs.js';
import { baseInventory, blockingServers, currentValues, missingKnobs, patchNumber, previewKnobs, restoreValues } from '../balanceControl.js';
import { applyKnobs, listRollouts } from '../balanceRollouts.js';

export interface KnobRouteOpts {
  db: DB;
  /** Null when balance/knobs.json failed to load: every route answers 503. */
  knobs: BalanceKnobs | null;
  /** Kicks a write pass after an apply. Absent in dev mode. */
  writer?: { sync(): Promise<unknown> };
}

/** The balance control panel (piece 4). Admin only; every apply audited. */
export async function adminBalanceKnobRoutes(app: FastifyInstance, opts: KnobRouteOpts): Promise<void> {
  const { db, knobs, writer } = opts;
  const requireAdmin = makeRequireAdmin(db);
  const unavailable = { error: 'balance/knobs.json failed to load; the knob panel is unavailable until it is fixed' };

  app.get('/api/admin/balance/knobs', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    if (!knobs) return reply.code(503).send(unavailable);
    const base = baseInventory(db);
    const active = listRollouts(db, knobs, 1).filter((r) => r.supersededAt === null)[0] ?? null;
    const restorable = (db.prepare(`SELECT id, name, source FROM balance_patches WHERE inputs_json IS NOT NULL ORDER BY first_seen_at DESC, id DESC`)
      .all() as { id: number; name: string | null; source: string }[]).map((p) => ({ ...p, number: patchNumber(db, p.id) }));
    return {
      knobs: adjustableKnobs(knobs),
      current: currentValues(db, knobs),
      base: base ? { patchId: base.patchId, number: patchNumber(db, base.patchId) } : null,
      missing: base ? missingKnobs(base.inventory, knobs) : [],
      blocking: base ? blockingServers(db, base.inventory, knobs) : [],
      active,
      restorable,
    };
  });

  app.post('/api/admin/balance/knobs/preview', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    if (!knobs) return reply.code(503).send(unavailable);
    return previewKnobs(db, knobs, (req.body as { values?: unknown } | undefined)?.values ?? {});
  });

  app.post('/api/admin/balance/knobs/apply', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    if (!knobs) return reply.code(503).send(unavailable);
    const b = (req.body ?? {}) as { values?: unknown; name?: unknown; notes?: unknown };
    const r = applyKnobs(db, knobs, { values: b.values ?? {}, name: b.name, notes: b.notes, adminId });
    if (!r.ok) return reply.code(r.status).send({ error: r.error, preview: r.preview });
    logAdmin(db, adminId, 'balance_apply', r.rolloutId, {
      patchId: r.patchId, reused: r.reused, changes: r.preview.diff.map((d) => `${d.cvar} ${d.from} -> ${d.to}`),
    });
    void writer?.sync();
    return { ok: true, rolloutId: r.rolloutId, patchId: r.patchId, reused: r.reused };
  });

  app.get('/api/admin/balance/knobs/restore/:patchId', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    if (!knobs) return reply.code(503).send(unavailable);
    const r = restoreValues(db, knobs, Number((req.params as { patchId: string }).patchId));
    if (!r.ok) return reply.code(400).send({ error: r.error });
    return { values: r.values, notes: r.notes };
  });

  app.get('/api/admin/balance/rollouts', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    if (!knobs) return reply.code(503).send(unavailable);
    return { rollouts: listRollouts(db, knobs) };
  });
}
```

(Check `makeRequireAdmin`'s import path and that it answers 403 for a signed-in non-admin, as `tests/balanceAdmin.test.ts` shows.)

`src/server.ts`: import it and `loadBalanceKnobs` is already imported. Right after `await app.register(adminRoutes, {...});` add:

```ts
  // Balance control panel. Loaded again here rather than reusing the log
  // listener's copy, which exists only outside dev mode; a failure disables
  // the panel (503) and nothing else.
  let panelKnobs: BalanceKnobs | null = null;
  try {
    panelKnobs = loadBalanceKnobs(deps.balanceKnobsPath);
  } catch (err) {
    console.error('[balance] knob panel disabled, balance/knobs.json failed to load:', err);
  }
  await app.register(adminBalanceKnobRoutes, { db: deps.db, knobs: panelKnobs, writer: deps.config.devMode ? undefined : balanceWriter });
```

- [ ] **Step 4: Run** `npx vitest run tests/balanceKnobRoutes.test.ts tests/balanceAdmin.test.ts` and `npm run typecheck`. Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/routes/adminBalanceKnobs.ts src/server.ts tests/balanceKnobRoutes.test.ts
git commit -m "admin balance: knob list, preview, apply, restore and rollout routes"
```

---

### Task 10: Knobs tab

**Files:**
- Modify: `web/src/api.ts` (types + `adminApi` entries next to the balance ones), `web/src/routes/admin/adminRoutes.ts` (`BALANCE_TABS`), `web/src/routes/Admin.tsx` (render), `web/src/routes/admin/AdminPatches.tsx` (the Rounds cell only), `web/src/routes/admin/adminRoutes.test.ts`
- Create: `web/src/routes/admin/balance/knobs.ts`, `web/src/routes/admin/balance/knobs.test.ts`, `web/src/routes/admin/balance/Knobs.tsx`, `web/src/routes/admin/balance/Knobs.test.tsx`

**Interfaces:**
- Consumes: Task 9 API.
- Produces (web/src/api.ts):
  ```ts
  export interface KnobView { cvar: string; label: string; group: string; type: 'int' | 'float'; min: number; max: number; step: number;
    baseline: string; unit?: string; note?: string; pairMax?: string }
  export interface KnobDiffRow { cvar: string; label: string; group: string; from: string; to: string }
  export interface KnobPreview { values: Record<string, string>; errors: string[]; diff: KnobDiffRow[]; groupsChanged: string[];
    base: { patchId: number; number: number } | null; missing: string[]; blocking: { serverId: number; name: string; diff: string }[];
    fingerprint: string | null; existingPatch: { id: number; number: number; name: string | null; notes: string; source: string } | null }
  export interface RolloutServer { serverId: number; name: string; state: 'pending' | 'written' | 'confirmed' | 'failed'; lastError: string | null;
    writtenAt: string | null; confirmedAt: string | null; seen: { patchId: number; number: number; at: string } | null; mismatch: string | null }
  export interface RolloutSummary { id: number; patchId: number; patchNumber: number; patchName: string | null; values: Record<string, string>;
    createdBy: string; createdByName: string | null; createdAt: string; supersededAt: string | null; servers: RolloutServer[] }
  export interface KnobsState { knobs: KnobView[]; current: Record<string, string>; base: { patchId: number; number: number } | null;
    missing: string[]; blocking: { serverId: number; name: string; diff: string }[]; active: RolloutSummary | null;
    restorable: { id: number; number: number; name: string | null; source: string }[] }
  adminApi.balanceKnobs(signal?) -> KnobsState
  adminApi.balanceKnobsPreview(values) -> KnobPreview
  adminApi.balanceKnobsApply(body: { values; name; notes }) -> { ok: true; rolloutId: number; patchId: number; reused: boolean }
  adminApi.balanceKnobsRestore(patchId) -> { values: Record<string,string>; notes: string[] }
  adminApi.balanceRollouts(signal?) -> { rollouts: RolloutSummary[] }
  ```
  `web/src/routes/admin/balance/knobs.ts`: `stepDecimals(step)`, `formatKnob(k, n)`, `snapKnob(k, raw: string): string` (clamp to range, round to the step grid, format), `serverStateText(s: RolloutServer): string`.

Server state wording (`serverStateText`):
- pending: "waiting for the server to be free"
- failed: "write failed: <lastError>, retrying"
- written, no mismatch: "written, awaiting first match"
- written or confirmed with mismatch: "expected #<rollout patch number>, saw #<seen.number>: <mismatch>" (the component passes the rollout's number; signature `serverStateText(s, expectedNumber)`)
- confirmed: "confirmed <confirmedAt>"

Page layout (`Knobs.tsx`), reuse `Panel`, `Empty` from `../../../components/bits`, `useFetch`, `useAction`, `fmtTime` like `AdminPatches.tsx`:
1. Status panel: "Predicting from patch #N" (or "No queue match has a fingerprint yet: nothing to predict from."), `missing` list, `blocking` list ("<name> differs in more than knob values: <diff>. Disable it or fix it before applying.").
2. Active rollout panel (if any): "Rollout of patch #N <name>, <createdAt> by <createdByName ?? createdBy>" and one line per server `<name>: <serverStateText>`.
3. Knobs, one `<fieldset>` per group (group name as `<legend>`): per knob a row with the label (and unit), `<input type="number" min max step aria-label={label}>` bound to the draft string, "now <current>", "baseline <baseline>", range "min to max", note if any. `onChange` sets `draft[cvar] = snapKnob(k, value)`.
4. Buttons: "Reset to baseline" (draft = baselines), a `<select aria-label="Restore from patch">` of `restorable` ("#N name" / "Unnamed patch N") with a "Restore" button (fills the draft from `balanceKnobsRestore`, shows its `notes` plus the fixed note "Only knob values change: plugins and files stay as they are now, so the result can be a new patch."), "Preview".
5. Preview panel: `errors` (class `error`), diff table (Knob, Now, New), a warning `.admin-warn` "This changes knobs in more than one group (tank, bosses): their effects cannot be told apart." when `groupsChanged.length > 1`, and either "Matches existing patch #N <name>: applying restores it." or "New patch, fingerprint <fp>." When there is an existing named patch the name/notes fields are hidden; otherwise show name (max 60) and notes (max 2000) inputs. A confirm input `aria-label="Type the patch name to confirm"`; the Apply button is enabled only when there are no errors, no blocking servers, no missing knobs, a non-empty diff or an existing patch, and the typed text equals the name (the existing patch's name when reused and named, else the name field, trimmed). Apply calls `balanceKnobsApply({ values: preview.values, name, notes })`, then reloads the knobs state and clears the preview.

- [ ] **Step 1: Failing tests**

`web/src/routes/admin/balance/knobs.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { formatKnob, serverStateText, snapKnob, stepDecimals } from './knobs';

const tank = { cvar: 't', label: 'Tank', group: 'tank', type: 'int' as const, min: 6000, max: 10000, step: 250, baseline: '8000' };
const flow = { cvar: 'f', label: 'Flow', group: 'b', type: 'float' as const, min: 0.1, max: 0.3, step: 0.05, baseline: '0.10' };

describe('knob values', () => {
  it('formats and snaps to the grid and range', () => {
    expect(stepDecimals(0.05)).toBe(2);
    expect(formatKnob(flow, 0.1)).toBe('0.10');
    expect(snapKnob(tank, '7600')).toBe('7500');
    expect(snapKnob(tank, '99999')).toBe('10000');
    expect(snapKnob(flow, '0.17')).toBe('0.15');
    expect(snapKnob(flow, 'abc')).toBe('0.10');
  });
});

describe('serverStateText', () => {
  const s = { serverId: 1, name: 'dallas', lastError: null, writtenAt: null, confirmedAt: null, seen: null, mismatch: null };
  it('says what each state means', () => {
    expect(serverStateText({ ...s, state: 'pending' }, 7)).toBe('waiting for the server to be free');
    expect(serverStateText({ ...s, state: 'failed', lastError: 'refused' }, 7)).toBe('write failed: refused, retrying');
    expect(serverStateText({ ...s, state: 'written' }, 7)).toBe('written, awaiting first match');
    expect(serverStateText({ ...s, state: 'written', seen: { patchId: 3, number: 3, at: 'x' }, mismatch: 'c:a 1 -> 2' }, 7))
      .toBe('expected #7, saw #3: c:a 1 -> 2');
    expect(serverStateText({ ...s, state: 'confirmed', confirmedAt: '2026-09-24 10:00:00' }, 7)).toMatch(/^confirmed/);
  });
});
```

`snapKnob` for non-numeric input returns the knob's baseline.

`web/src/routes/admin/balance/Knobs.test.tsx` (mock pattern from `AdminPatches.test.tsx`):

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { KnobPreview, KnobsState } from '../../../api';

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { balanceKnobs: vi.fn(), balanceKnobsPreview: vi.fn(), balanceKnobsApply: vi.fn(), balanceKnobsRestore: vi.fn() },
}));
vi.mock('../../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api')>();
  return { ...actual, adminApi: { ...actual.adminApi, ...mockAdmin } };
});
const { Knobs } = await import('./Knobs');
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const state: KnobsState = {
  knobs: [
    { cvar: 'z_tank_health', label: 'Tank base health', group: 'tank', type: 'int', min: 6000, max: 10000, step: 250, baseline: '8000' },
    { cvar: 'versus_boss_flow_min', label: 'Boss flow min', group: 'bosses', type: 'float', min: 0.1, max: 0.3, step: 0.05, baseline: '0.10' },
  ],
  current: { z_tank_health: '7500', versus_boss_flow_min: '0.10' },
  base: { patchId: 6, number: 6 }, missing: [], blocking: [],
  active: { id: 1, patchId: 8, patchNumber: 8, patchName: 'Tank 7500', values: {}, createdBy: 'a', createdByName: 'Admin', createdAt: '2026-09-24 10:00:00', supersededAt: null,
    servers: [{ serverId: 1, name: 'dallas', state: 'written', lastError: null, writtenAt: 'x', confirmedAt: null, seen: null, mismatch: null }] },
  restorable: [{ id: 6, number: 6, name: null, source: 'detected' }],
};
const preview = (over: Partial<KnobPreview> = {}): KnobPreview => ({
  values: { z_tank_health: '8000', versus_boss_flow_min: '0.15' }, errors: [], groupsChanged: ['tank', 'bosses'],
  diff: [{ cvar: 'z_tank_health', label: 'Tank base health', group: 'tank', from: '7500', to: '8000' },
    { cvar: 'versus_boss_flow_min', label: 'Boss flow min', group: 'bosses', from: '0.10', to: '0.15' }],
  base: { patchId: 6, number: 6 }, missing: [], blocking: [], fingerprint: 'abcdef0123456789', existingPatch: null, ...over,
});

describe('Knobs', () => {
  it('shows knobs by group with current and baseline, and the rollout state', async () => {
    mockAdmin.balanceKnobs.mockResolvedValue(state);
    render(<Knobs />);
    expect(await screen.findByText('Tank base health')).toBeTruthy();
    expect(screen.getByText('tank')).toBeTruthy();
    expect(screen.getByText(/baseline 8000/)).toBeTruthy();
    expect(screen.getByText(/dallas: written, awaiting first match/)).toBeTruthy();
  });

  it('reset to baseline fills the draft, preview warns about two groups', async () => {
    mockAdmin.balanceKnobs.mockResolvedValue(state);
    mockAdmin.balanceKnobsPreview.mockResolvedValue(preview());
    render(<Knobs />);
    await screen.findByText('Tank base health');
    fireEvent.click(screen.getByText('Reset to baseline'));
    expect((screen.getByLabelText('Tank base health') as HTMLInputElement).value).toBe('8000');
    fireEvent.click(screen.getByText('Preview'));
    await waitFor(() => expect(mockAdmin.balanceKnobsPreview).toHaveBeenCalledWith({ z_tank_health: '8000', versus_boss_flow_min: '0.10' }));
    expect(await screen.findByText(/more than one group/)).toBeTruthy();
  });

  it('apply needs the typed name and sends values, name and notes', async () => {
    mockAdmin.balanceKnobs.mockResolvedValue(state);
    mockAdmin.balanceKnobsPreview.mockResolvedValue(preview());
    mockAdmin.balanceKnobsApply.mockResolvedValue({ ok: true, rolloutId: 2, patchId: 9, reused: false });
    render(<Knobs />);
    await screen.findByText('Tank base health');
    fireEvent.click(screen.getByText('Preview'));
    await screen.findByText(/New patch/);
    fireEvent.input(screen.getByLabelText('Patch name'), { target: { value: 'Back to 8000' } });
    fireEvent.input(screen.getByLabelText('Patch notes'), { target: { value: 'revert' } });
    const apply = screen.getByText('Apply to all servers') as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    fireEvent.input(screen.getByLabelText('Type the patch name to confirm'), { target: { value: 'Back to 8000' } });
    expect(apply.disabled).toBe(false);
    fireEvent.click(apply);
    await waitFor(() => expect(mockAdmin.balanceKnobsApply).toHaveBeenCalledWith({
      values: { z_tank_health: '8000', versus_boss_flow_min: '0.15' }, name: 'Back to 8000', notes: 'revert' }));
  });

  it('blocking servers disable apply and are listed', async () => {
    mockAdmin.balanceKnobs.mockResolvedValue({ ...state, blocking: [{ serverId: 2, name: 'chicago', diff: 'added p:x.smx' }] });
    render(<Knobs />);
    expect(await screen.findByText(/chicago differs in more than knob values/)).toBeTruthy();
  });

  it('restore fills the draft from a patch and says plugins stay', async () => {
    mockAdmin.balanceKnobs.mockResolvedValue(state);
    mockAdmin.balanceKnobsRestore.mockResolvedValue({ values: { z_tank_health: '9000', versus_boss_flow_min: '0.20' }, notes: [] });
    render(<Knobs />);
    await screen.findByText('Tank base health');
    fireEvent.click(screen.getByText('Restore'));
    await waitFor(() => expect((screen.getByLabelText('Tank base health') as HTMLInputElement).value).toBe('9000'));
    expect(screen.getByText(/plugins and files stay as they are now/)).toBeTruthy();
  });
});
```

`web/src/routes/admin/adminRoutes.test.ts`: add `expect(parseAdminPath('/admin/balance/knobs', { isAdmin: true })).toEqual({ desk: 'balance', section: 'knobs', param: null });`.

`web/src/routes/admin/AdminPatches.test.tsx`: add a test that an `announced` patch with `rounds: 0` shows "never played".

- [ ] **Step 2: Run** `npx vitest run web/src/routes/admin` . Expected: FAIL.

- [ ] **Step 3: Implement**

`web/src/routes/admin/balance/knobs.ts`:

```ts
import type { KnobView, RolloutServer } from '../../../api';

export function stepDecimals(step: number): number {
  const s = String(step);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

/** Same string the server writes (src/balanceKnobs.ts formatKnobValue). */
export function formatKnob(k: Pick<KnobView, 'type' | 'step'>, n: number): string {
  return k.type === 'int' ? String(Math.round(n)) : n.toFixed(stepDecimals(k.step));
}

/** An input value clamped to the range and rounded to the step grid. */
export function snapKnob(k: KnobView, raw: string): string {
  const n = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(n)) return k.baseline;
  const clamped = Math.min(k.max, Math.max(k.min, n));
  return formatKnob(k, k.min + Math.round((clamped - k.min) / k.step) * k.step);
}

export function serverStateText(s: RolloutServer, expectedNumber: number): string {
  if (s.mismatch && s.seen) return `expected #${expectedNumber}, saw #${s.seen.number}: ${s.mismatch}`;
  if (s.state === 'pending') return 'waiting for the server to be free';
  if (s.state === 'failed') return `write failed: ${s.lastError ?? 'unknown error'}, retrying`;
  if (s.state === 'written') return 'written, awaiting first match';
  return `confirmed ${s.confirmedAt ?? ''}`.trim();
}
```

`web/src/api.ts`: add the interfaces above near `PatchSummary`, and in `adminApi` after `editBalancePatch`:

```ts
  balanceKnobs: (signal?: AbortSignal) => get<KnobsState>('/api/admin/balance/knobs', signal),
  balanceKnobsPreview: (values: Record<string, string>) => post<KnobPreview>('/api/admin/balance/knobs/preview', { values }),
  balanceKnobsApply: (body: { values: Record<string, string>; name: string; notes: string }) =>
    post<{ ok: true; rolloutId: number; patchId: number; reused: boolean }>('/api/admin/balance/knobs/apply', body),
  balanceKnobsRestore: (patchId: number) => get<{ values: Record<string, string>; notes: string[] }>(`/api/admin/balance/knobs/restore/${patchId}`),
  balanceRollouts: (signal?: AbortSignal) => get<{ rollouts: RolloutSummary[] }>('/api/admin/balance/rollouts', signal),
```

`web/src/routes/admin/balance/Knobs.tsx`:

```tsx
import { useEffect, useState } from 'preact/hooks';
import { adminApi, type KnobPreview, type KnobView } from '../../../api';
import { useFetch } from '../../../hooks/useFetch';
import { Empty, Panel } from '../../../components/bits';
import { fmtTime, useAction } from '../useAction';
import { serverStateText, snapKnob } from './knobs';

const patchLabel = (p: { number: number; name: string | null }) => p.name ?? `Unnamed patch ${p.number}`;
const RESTORE_NOTE = 'Only knob values change: plugins and files stay as they are now, so the result can be a new patch.';

/** The balance control panel: draft knob values, preview the predicted
 *  patch, apply to every server, and follow the rollout per server.
 *  docs/superpowers/specs/2026-09-24-balance-control-panel-design.md */
export function Knobs() {
  const st = useFetch((s) => adminApi.balanceKnobs(s), []);
  // useAction reloads after every run; preview and restore must not.
  const { busy, error, run } = useAction(() => {});
  const applyAction = useAction(st.reload);
  const [seeded, setSeeded] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<KnobPreview | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [restoreId, setRestoreId] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [patchNotes, setPatchNotes] = useState('');
  const [confirm, setConfirm] = useState('');

  const data = st.data;
  // The draft starts from the current values once, and again only after an
  // apply; a reload must never overwrite what the admin is editing.
  useEffect(() => { if (data && !seeded) { setDraft({ ...data.current }); setSeeded(true); } }, [data, seeded]);
  useEffect(() => { if (data && restoreId === null && data.restorable[0]) setRestoreId(data.restorable[0].id); }, [data]);

  if (st.error) return <Empty>Could not load the knob panel.</Empty>;
  if (!data) return <p class="muted">Loading...</p>;

  const edit = (next: Record<string, string>) => { setDraft(next); setPreview(null); setConfirm(''); };
  const groups = [...new Set(data.knobs.map((k) => k.group))];
  const existing = preview?.existingPatch ?? null;
  const expectedName = existing?.name ?? name.trim();
  const canApply = !!preview && preview.errors.length === 0 && preview.missing.length === 0 && preview.blocking.length === 0
    && (preview.diff.length > 0 || existing !== null) && expectedName !== '' && confirm.trim() === expectedName
    && (existing !== null || patchNotes.trim() !== '');

  const row = (k: KnobView) => (
    <div class="admin-form" key={k.cvar}>
      <label>
        <span>{k.label}{k.unit ? ` (${k.unit})` : ''}</span>
        <input type="number" aria-label={k.label} min={k.min} max={k.max} step={k.step} value={draft[k.cvar] ?? ''}
          onChange={(e) => edit({ ...draft, [k.cvar]: snapKnob(k, (e.target as HTMLInputElement).value) })} />
      </label>
      <span class="muted">now {data.current[k.cvar]}, baseline {k.baseline}, range {k.min} to {k.max}{k.note ? `. ${k.note}` : ''}</span>
    </div>
  );

  return (
    <div class="stack">
      <Panel>
        <h3>Servers</h3>
        {data.base ? <p class="muted">Predicting from patch #{data.base.number}, the latest queue match.</p>
          : <p class="error">No queue match has a fingerprint yet: nothing to predict from.</p>}
        {data.missing.length > 0 && <p class="error">Not reported by the servers: {data.missing.join(', ')}.</p>}
        {data.blocking.map((b) => (
          <p class="error" key={b.serverId}>{b.name} differs in more than knob values: {b.diff}. Disable it or fix it before applying.</p>
        ))}
        {data.active && (
          <div>
            <p>Rollout of patch #{data.active.patchNumber} {data.active.patchName ?? ''}, {fmtTime(data.active.createdAt)} by {data.active.createdByName ?? data.active.createdBy}</p>
            <ul class="admin-list">
              {data.active.servers.map((s) => <li key={s.serverId}>{s.name}: {serverStateText(s, data.active!.patchNumber)}</li>)}
            </ul>
          </div>
        )}
      </Panel>
      <Panel>
        <h3>Knobs</h3>
        {groups.map((g) => (
          <fieldset key={g}>
            <legend>{g}</legend>
            {data.knobs.filter((k) => k.group === g).map(row)}
          </fieldset>
        ))}
        <div class="admin-form">
          <button class="btn" type="button" onClick={() => { edit(Object.fromEntries(data.knobs.map((k) => [k.cvar, k.baseline]))); setNotes([]); }}>Reset to baseline</button>
          <select aria-label="Restore from patch" value={restoreId ?? ''} onChange={(e) => setRestoreId(Number((e.target as HTMLSelectElement).value))}>
            {data.restorable.map((p) => <option key={p.id} value={p.id}>#{p.number} {patchLabel(p)}</option>)}
          </select>
          <button class="btn" type="button" disabled={busy || restoreId === null} onClick={() => void run(async () => {
            const r = await adminApi.balanceKnobsRestore(restoreId!);
            edit(r.values);
            setNotes([...r.notes, RESTORE_NOTE]);
          })}>Restore</button>
          <button class="btn" type="button" disabled={busy} onClick={() => void run(async () => {
            const p = await adminApi.balanceKnobsPreview(draft);
            setPreview(p);
            setName(p.existingPatch?.name ?? '');
            setPatchNotes('');
            setConfirm('');
          })}>Preview</button>
        </div>
        {notes.map((n) => <p class="muted" key={n}>{n}</p>)}
        {error && <p class="error">{error}</p>}
      </Panel>
      {preview && (
        <Panel>
          <h3>Preview</h3>
          {preview.errors.map((e) => <p class="error" key={e}>{e}</p>)}
          {preview.diff.length === 0 ? <p class="muted">No knob changes from what the servers should be running now.</p> : (
            <table class="admin-table">
              <thead><tr><th>Knob</th><th>Now</th><th>New</th></tr></thead>
              <tbody>{preview.diff.map((d) => <tr key={d.cvar}><td>{d.label}</td><td>{d.from}</td><td>{d.to}</td></tr>)}</tbody>
            </table>
          )}
          {preview.groupsChanged.length > 1 && (
            <p class="admin-warn">This changes knobs in more than one group ({preview.groupsChanged.join(', ')}): their effects cannot be told apart.</p>
          )}
          {existing
            ? <p>Matches existing patch #{existing.number} {patchLabel(existing)}: applying restores it.</p>
            : preview.fingerprint && <p>New patch, fingerprint {preview.fingerprint}.</p>}
          <form class="admin-form" onSubmit={(e) => {
            e.preventDefault();
            if (!canApply) return;
            void applyAction.run(async () => {
              await adminApi.balanceKnobsApply({ values: preview.values, name: name.trim(), notes: patchNotes });
              setPreview(null);
              setConfirm('');
              setSeeded(false);
            });
          }}>
            {(!existing || !existing.name) && (
              <input value={name} maxLength={60} placeholder="Patch name" aria-label="Patch name" onInput={(e) => setName((e.target as HTMLInputElement).value)} />
            )}
            {!existing && (
              <textarea value={patchNotes} maxLength={2000} placeholder="What changed and why" aria-label="Patch notes"
                onInput={(e) => setPatchNotes((e.target as HTMLTextAreaElement).value)} />
            )}
            <p class="muted">Servers: {data.active?.servers.map((s) => s.name).join(', ') || 'every enabled server'}. Each gets the file between matches.</p>
            <input value={confirm} placeholder={expectedName || 'patch name'} aria-label="Type the patch name to confirm"
              onInput={(e) => setConfirm((e.target as HTMLInputElement).value)} />
            <button class="btn" type="submit" disabled={busy || applyAction.busy || !canApply}>Apply to all servers</button>
            {applyAction.error && <p class="error">{applyAction.error}</p>}
          </form>
        </Panel>
      )}
    </div>
  );
}
```

(Match `AdminPatches.tsx` for imports and helpers; adjust class names to what exists in `web/src/styles/app.css`. The "Servers:" line lists the active rollout's servers as a stand-in for "the servers"; if the knobs state is extended to list enabled servers, use that instead. Keep the test-visible texts exactly as in the tests.)

`adminRoutes.ts`: append `{ key: 'knobs', label: 'Knobs', path: '/admin/balance/knobs' }` to `BALANCE_TABS` (after Patches). `Admin.tsx`: import `Knobs` and add `{r.desk === 'balance' && r.section === 'knobs' && <Knobs />}` after the Patches line. `AdminPatches.tsx` Rounds cell: `<td>{p.source === 'announced' && p.rounds === 0 ? 'never played' : p.rounds}</td>` (the only change in that file).

- [ ] **Step 4: Run** `npx vitest run web/` and `npm run typecheck`. Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add web/src
git commit -m "admin balance: Knobs tab with preview, apply, restore and per-server rollout state"
```

---

### Task 11: Rig verification (unattended, safe, or pending)

**Goal:** On the isolated local test instance, prove that (a) a value written through `cfg/pug_balance.cfg` executed at the end of `rotoblin_pug_4v4_map.cfg` is what the plugin reports in `c:`, byte for byte, including a `"0.10"`/`"0.15"`-style float, (b) the fingerprint the site predicts equals the fingerprint of the real sighting after the change, and (c) each knob's min and max are not rewritten by the engine (no clamping to a `%f` string).

**Hard safety rules (stop and mark PENDING-OWNER if any cannot be met):**
- Only `/home/volence/l4d1-ds-skyprobe/server`, port 27045, `-ip 127.0.0.1 -insecure -nomaster +sv_lan 1`. Never ssh, rcon, scp, FTP, sftp, `deploy.sh`, `stage.sh`, or any real host. Console input only through a FIFO on srcds stdin (recipe in `plugin/TESTING.md` "Balance inventory verification").
- Pre-check: `pgrep -af "srcds_linux"` must show nothing on port 27045 and no other session's srcds using that instance; if any srcds uses `/home/volence/l4d1-ds-skyprobe`, do not run: mark PENDING-OWNER.
- Back up everything touched to the scratchpad first: the instance's `addons/sourcemod/plugins` dir, `cfg/server.cfg`, `cfg/rotoblin_pug_4v4_map.cfg` (if present), any existing `cfg/pug_balance.cfg`. Restore after, and prove with `diff -r` / `diff`; remove `pug_balance.cfg` if it did not exist before.
- Every srcds run wrapped in `timeout`, stopped with `quit`; final check nothing on 27045.

**Steps:**
- [ ] 1. Read `plugin/TESTING.md` "Balance inventory verification" and follow its setup (build `plugin/pug-match.smx` from this worktree with `plugin/build.sh` only if the instance needs it; the balance code is unchanged by this plan, so the existing build is fine).
- [ ] 2. If the instance lacks `rotoblin_pug_4v4_map.cfg` or the PUG chain (check `cfg/`), mark PENDING-OWNER with what is missing. Otherwise append `exec pug_balance.cfg` to the instance copy (backed up).
- [ ] 3. Write `cfg/pug_balance.cfg` with every knob at baseline (use `renderBalanceCfg` from `src/balanceControl.ts` via a scratch `tsx` script with the shipped knobs.json, a fake patch number, e.g. 0 and name "rig"). Start srcds, `exec pug_match`, set up a fake match exactly as the recipe does (`sm_pug_match`, roster, bots, `sm_forcestart`), capture the BALANCE parts from the SourceMod log, reassemble with `BalanceAssembler`/`parseLogLine` in a scratch script, and record inventory A and its fingerprint (`fingerprintOf(withoutIgnored(A, ignored), versionless)`).
- [ ] 4. Draft B = baseline with `z_tank_health 7500` and `versus_boss_flow_min 0.15`, and draft C = baseline with `versus_boss_flow_min 0.10` explicitly and `versus_boss_flow_max 0.85`. For each: predicted = `fingerprintOf(predictInventory(A, knobs, draft), versionless)`; write the rendered file; `changelevel` (or a new fake match) to re-run the chain; capture the sighting; compare the reported `c:` strings with the draft strings and the real fingerprint with the prediction.
- [ ] 5. Bounds: one file with every knob at its `min`, one with every knob at its `max` (pairs stay valid: min and max files set both members to the same bound); after each changelevel, `c:` for every knob must equal the written string exactly. Any rewritten value (for example `"0.100000"` or a clamped number) is a finding: shrink that range in `balance/knobs.json` in a fix commit and re-run.
- [ ] 6. Teardown and restore as above; record every command, every captured value and the diffs in the task report, and add a short "Balance control panel verification" section to `plugin/TESTING.md` (recipe + result). Commit the TESTING.md change (and any range fix).
- [ ] 7. Anything that could not be verified unattended is reported as PENDING-OWNER with exact steps. Never fake a result.

---

## Owner runbook (not executed by this plan)

1. Review the knob table in `balance/knobs.json` (ranges and steps) and the rig result in `plugin/TESTING.md`.
2. Deploy repo hook. Proposed diff, to apply by hand in `/home/volence/l4d/deploy` (both copies; `state/*` are snapshots, leave them):

```diff
--- a/overrides/left4dead/cfg/rotoblin_pug_4v4_map.cfg
+++ b/overrides/left4dead/cfg/rotoblin_pug_4v4_map.cfg
@@ -60,3 +60,8 @@ l4d_vote_KickED 0
 l4d_vote_ForceSpectateED 0
 l4d_vote_alltalkED 0
 l4d_vote_alltalk2ED 0
+
+//-----------------------------------------
+// Balance knobs set from riversidepug.com (Admin > Balance > Knobs). The site
+// writes cfg/pug_balance.cfg; it must never be committed here. Must stay last.
+exec pug_balance.cfg
--- a/nfo/stage/left4dead/cfg/rotoblin_pug_4v4_map.cfg
+++ b/nfo/stage/left4dead/cfg/rotoblin_pug_4v4_map.cfg
(same hunk)
```

   The file is watched (`cfg/rotoblin_pug_4v4_map.cfg` in knobs.json `files`), so the next match on each box raises one "new patch" alert: name that patch ("pug_balance hook"). A missing `pug_balance.cfg` only prints "couldn't exec pug_balance.cfg".
3. Check the web app can create and rename files in each box's `left4dead/cfg`: Dallas as user `pug` (group `l4d`, dir group-writable after `deploy.sh`'s `--chmod=Dg+w`), Chicago over FTP, Riverside #3/#4 over sftp as the configured user. Never commit a `pug_balance.cfg` to the deploy repo, and do not re-upload an old `nfo/stage` tree that contains one.
4. Merge the branch and deploy the web app (normal web deploy; no plugin change in this piece).
5. After a queue match has been played on the hooked config: Knobs tab, "Reset to baseline", Preview. It must say "Matches existing patch #N" (the hook patch). Apply it (name it if unnamed). Every server should go written, then confirmed after its next match.
6. Only then make a real change.
