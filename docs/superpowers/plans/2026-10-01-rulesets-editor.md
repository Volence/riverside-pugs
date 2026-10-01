# Rulesets editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admins edit match rulesets and game configs from Admin > Setup (copy, edit, archive rulesets; add, relabel, turn off and delete game configs), and the booking and event-stage pickers say what each pick means.

**Architecture:** Two new domain modules own every write after seeding: `src/rulesetStore.ts` (rulesets) and `src/gameConfigStore.ts` (game configs). Each write is one better-sqlite3 transaction that re-reads, checks, writes and adds its `logAdmin` row with the before and after; a refusal returns `{ ok: false, error }` with a key into an error table, like `src/teams/teams.ts` and `src/events/events.ts`. One admin-only route file, `src/routes/adminRulesets.ts`, maps refusals to a status and sentence. Bookings and event stages already keep their own copy of the rules (`bookings.rules_json`, `event_stages.rules_json`), so editing a ruleset never touches them. Two new columns make the desk's "in use" counts possible (`bookings.ruleset_id`) and say where a copy came from (`rulesets.based_on`). A one-line summary (`rulesSummary` in `src/events/format.ts`) travels in the picker options payloads, so the web needs no copy of it. The web gains two Setup tabs (Rulesets, Game configs) in the Settings desk row layout (`FormRow`), and help lines under the Ruleset and Game config pickers on the stage form and the booking form.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes on the server), Fastify 5, better-sqlite3, vitest (`npm test`, `npx vitest run <file>`), `npm run typecheck` (server and web), `npm run build`; Preact + preact-iso + @testing-library/preact (happy-dom) for the web.

**Spec:** `docs/superpowers/specs/2026-09-30-competitive-foundation-design.md`, section 1, "Rulesets: game config plus match rules" (two layers, staff-approved game configs, named rulesets with templates, every match keeps a copy, editing never rewrites history). Scope and binding decisions: the controller's rulesets-editor decisions of 2026-10-01 (owner: rulesets "should definitely be editable"), copied into Global Constraints below.

## Global Constraints

- Admin > Setup gets a "Rulesets" tab and a sibling "Game configs" tab. Admins only; mods have no access (every route, reads included, uses `makeRequireAdmin`; the Setup desk is already admin-only in `web/src/routes/admin/adminRoutes.ts`).
- Ruleset list: name, the template it came from, a one-line summary, the in-use count (open bookings plus unfinished events referencing it), an archived badge. New = a copy of a chosen existing ruleset under a new unique name. Edit = every `MatchRules` field except `rated` and `penalties`: pause limit (blank = unlimited), pause seconds (blank = unlimited), `mutualUnpause`, `techPauses` 0 to 5, `teamLock`, `playerMapControl`, `restartHalf.allowed` and `lockAfterDamage`, `noShowGraceMinutes` 5 to 60, `bosses`, `sideRule`, `spectate.sideLocked`. Archive and Unarchive.
- The PUG ruleset is read only (it mirrors the live PUG cfg; it is the only rated one). Every other ruleset is stored with `rated: false` and `penalties: false`; the editor hides both fields.
- Editing a ruleset never touches a snapshot (`bookings.rules_json`, `event_stages.rules_json`, `matches.rules_json`). The page says: "Changes apply to new bookings and events; running and finished ones keep the rules they started with".
- An archived ruleset disappears from the booking and event pickers; existing references keep working; event publish keeps refusing an archived ruleset (T1a Ruling 20).
- Game configs: list (key, label, cfg, enabled, in use), edit label, enable or disable, add new with key `^[a-z0-9_]{2,32}$`, label, cfg `^[a-z0-9_]+$`, and a warning that the cfg file must exist on every pool server (setup runs `exec <cfg>`). `standard` cannot be disabled or deleted. A config in use cannot be deleted; an unused one can.
- Every write: one transaction, `logAdmin` with before/after detail. Ruleset names unique case-insensitively, 3 to 40 characters, trimmed.
- Pickers: the stage form and the booking form show a muted help line under Ruleset ("Match rules: pauses, side choice, no-show grace") plus the one-line summary of the selected ruleset, and under Game config "What the server runs (the cfg it loads)". The summary ships in the options payload (server `src/events/format.ts` owns it).
- Layout matches the Settings desk and `FormRow` (label and help left, control right, one column on a phone). No horizontal scroll at phone width.
- Never write em dashes in code, comments, copy, commits or docs.
- Commit messages follow the repo style (plain sentence). Do not push. Do not deploy, restart, stage or rcon any live box.
- Several Claude sessions use `/home/volence/l4d/pug`: work in a worktree branch; check `git reflog -10` and `git status` before any write on master.

## Rulings this plan makes (for the owner to confirm)

1. **A booking remembers its ruleset.** Bookings stored only the rules copy, so nothing could count "open bookings using ruleset X". New nullable column `bookings.ruleset_id`, written by `createBooking`. Bookings made before this have null and are not counted.
2. **"The template it came from" is a new column `rulesets.based_on`** (the id a copy was made from). The list shows "Built-in" for the three seeded templates and "Copy of <name>" for a copy.
3. **The three built-ins keep their names and are never archived.** Code finds them by name (`createBooking`'s default is `'Casual Scrim'`, the event desk's default is `'Standard Cup'`), and `seedRulesetTemplates` inserts by name on every start, so a renamed built-in would come back as a second copy. Standard Cup's and Casual Scrim's rules stay editable; PUG stays read only.
4. **Ranges the decisions left open:** pauses per team 0 to 10 or blank (no limit); pause length 30 to 600 seconds or blank (no limit); game config label 3 to 60 characters; cfg at most 64 characters. Names and labels refuse control characters.
5. **`logAdmin` runs inside the store's transaction**, so the write and its audit row land together or not at all (the event desk writes `logAdmin` after its own transaction; here there is no separate audit table, so the admin audit row is the one).
6. **`lockAfterDamage` is stored false whenever `restartHalf.allowed` is false**, and the editor shows "Only before damage" only while restarts are on.
7. **A game config's cfg is fixed once made**; only its label and on/off change. A different cfg is a new config, so the audit log never shows one key meaning two files.
8. **The booking form gains a Game config picker only when more than one config is enabled** (it had none; it always sent the default). Same rule the Rules picker already follows.
9. **Summary wording:** "3 pauses of 120 s · coin toss for sides · 10 min no-show grace" (no limit reads "Unlimited pauses", 0 reads "No pauses").
10. **"In use":** open bookings are those in a capacity state (`OPEN_STATES_SQL`: scheduled, held, setup, ready, active); unfinished events are every status but finished and cancelled, drafts included. A copy may be made from an archived ruleset. A copy of PUG is unrated and has no penalties.
11. **Deleting an unused config** leaves finished bookings and events naming its key; their pages already fall back to showing the key when the label is gone.
12. **A draft event still previews the live ruleset** (as T1a does), so an edit shows on a draft's page until publish takes the copy. That matches "changes apply to new events".

## Not in this plan (and why)

- Pushing rules to the server per match (`sm_pug_pause_mutual` and friends): enforcement belongs to the match-flow plans; this plan only edits what gets copied.
- Uploading or checking cfg files on the pool servers: the desk warns; the deploy tooling owns files.
- Organizer (non-admin) ruleset editing: the spec mentions organizers copying a template per event; today only admins run events.

## Review Focus

- **A built-in renamed or archived.** Renaming "Casual Scrim" would make every booking without a picked ruleset fail and the seed re-add a second "Casual Scrim" on restart; archiving it would do the first. Both must be refused with a sentence, and PUG must stay byte-identical. Task 2 tests (`'PUG is read only, a template keeps its name, and a name cannot clash'`, `'never archives a template'`).
- **A blank pause field versus 0.** Blank means no limit (null); "0" means no pauses. A blank grace or technical pauses must be caught before anything is sent. Task 2 (`readEditableRules`) and Task 5 (`rulesDraft`) tests.
- **An edit after a booking and a published stage took their copy.** Both copies stay byte-identical and the booking page still shows the old grace. Task 4 test (`'editing a ruleset leaves a booking and a published stage on the rules they took'`).
- **A cfg that is more than one console word.** `pug_match; quit`, `zonemod.cfg`, `../server` or an empty cfg must be refused, since setup runs `exec <cfg>` over rcon. Tasks 3 and 4 tests.
- **Archiving or turning off something in use.** A draft stage on an archived ruleset is refused at publish; a booking cannot pick an archived ruleset; a config an open booking uses cannot be deleted; standard cannot be turned off. Tasks 3 and 4 tests.

---

## File map

| File | Responsibility |
|---|---|
| `src/db.ts` | Migrations: `rulesets.based_on`, `bookings.ruleset_id`. |
| `src/bookings/bookings.ts` | `createBooking` stores the ruleset id next to its copy. |
| `src/events/format.ts` | `rulesSummary`: a ruleset in one line. |
| `src/rulesetStore.ts` | Ruleset reads (list, in use, picker options) and every ruleset write, each audited. |
| `src/gameConfigStore.ts` | Game config reads and every game config write, each audited. |
| `src/routes/adminRulesets.ts` | Admin-only HTTP surface for both desks. |
| `src/server.ts` | Registers the routes. |
| `src/routes/bookings.ts`, `src/routes/adminEvents.ts` | Picker options carry each ruleset's summary. |
| `web/src/api.ts` | Types and `adminApi` calls. |
| `web/src/routes/admin/adminRoutes.ts`, `web/src/routes/Admin.tsx` | The two Setup tabs. |
| `web/src/routes/admin/rulesets/rulesDraft.ts` | Pure: the editor's typed numbers to rules. |
| `web/src/routes/admin/rulesets/RulesetForm.tsx`, `AdminRulesets.tsx` | Rulesets tab. |
| `web/src/routes/admin/rulesets/AdminGameConfigs.tsx` | Game configs tab. |
| `web/src/routes/admin/events/StageForm.tsx`, `web/src/routes/Bookings.tsx` | Picker help lines and summaries. |
| `web/src/styles/app.css` | Three small blocks (list rows, the cfg warning, the booking pickers). |

---

### Task 1: The booking's ruleset, where a copy came from, and the one-line summary

**Files:**
- Modify: `src/db.ts` (in `openDb`'s migrations, right before `db.prepare(` `"INSERT OR IGNORE INTO game_configs ...`)
- Modify: `src/bookings/bookings.ts` (`BookingRow`, `pickRules`, the `INSERT INTO bookings` in `createBooking`)
- Modify: `src/events/format.ts` (append)
- Test: `tests/rulesets.test.ts`, `tests/bookings.test.ts`, `tests/eventFormat.test.ts`

**Interfaces:**
- Consumes: `ensureColumn(db, table, column, ddl)` (private to `src/db.ts`), `MatchRules` from `src/rulesets.ts`.
- Produces: columns `rulesets.based_on INTEGER` (null for templates) and `bookings.ruleset_id INTEGER` (set by `createBooking`); `BookingRow.ruleset_id: number | null`; `export function rulesSummary(r: MatchRules): string` in `src/events/format.ts`.

- [ ] **Step 1: Write the failing tests**

In `tests/eventFormat.test.ts`, change the import line to

```ts
import { chaptersLabel, rulesLines, rulesSummary, stageSummary } from '../src/events/format.js';
```

and append:

```ts
describe('rules summary', () => {
  it('says the pauses, the side rule and the no-show grace in one line', () => {
    expect(rulesSummary(TEMPLATES.PUG)).toBe('3 pauses of 120 s · coin toss for sides · 10 min no-show grace');
    expect(rulesSummary(TEMPLATES['Standard Cup'])).toBe('3 pauses of 120 s · higher seed picks sides · 15 min no-show grace');
    expect(rulesSummary(TEMPLATES['Casual Scrim'])).toBe('Unlimited pauses · non-picker picks sides · 15 min no-show grace');
  });

  it('reads one pause, no pauses, and unlimited pauses with a length', () => {
    const one = { ...TEMPLATES.PUG, pause: { ...TEMPLATES.PUG.pause, limit: 1, seconds: null } };
    expect(rulesSummary(one)).toBe('1 pause · coin toss for sides · 10 min no-show grace');
    const none = { ...TEMPLATES.PUG, pause: { ...TEMPLATES.PUG.pause, limit: 0 } };
    expect(rulesSummary(none)).toBe('No pauses · coin toss for sides · 10 min no-show grace');
    const long = { ...TEMPLATES.PUG, pause: { ...TEMPLATES.PUG.pause, limit: null, seconds: 60 } };
    expect(rulesSummary(long)).toBe('Unlimited pauses of 60 s · coin toss for sides · 10 min no-show grace');
  });
});
```

In `tests/rulesets.test.ts`, inside `describe('rulesets', ...)`, before `it('only the PUG template is rated', ...)`:

```ts
  it('the templates are copies of nothing', () => {
    const db = openDb(':memory:');
    expect(db.prepare('SELECT DISTINCT based_on FROM rulesets').all()).toEqual([{ based_on: null }]);
  });
```

In `tests/bookings.test.ts`, inside `describe('creating', ...)`, before `it('refuses bad input with a reason', ...)`:

```ts
  it('keeps the ruleset a booking was made under next to its snapshot', () => {
    const id = (name: string) => (db.prepare('SELECT id FROM rulesets WHERE name = ?').get(name) as { id: number }).id;
    expect(getBooking(db, create())!.ruleset_id).toBe(id('Casual Scrim'));
    const cup = create({ by: P[2], opponent: { steamid: P[3] }, rulesetId: id('Standard Cup') });
    expect(getBooking(db, cup)!.ruleset_id).toBe(id('Standard Cup'));
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/eventFormat.test.ts tests/rulesets.test.ts tests/bookings.test.ts`
Expected: FAIL: `rulesSummary is not a function`, `no such column: based_on`, and `expected undefined to be 3` for `ruleset_id`.

- [ ] **Step 3: Add the columns**

In `src/db.ts`, right before

```ts
  db.prepare(
    "INSERT OR IGNORE INTO game_configs (key, label, cfg) VALUES ('standard', 'Standard (Rotoblin PUG 4v4)', 'pug_match')",
```

insert:

```ts
  // Rulesets editor: the ruleset a copy was made from (null for the three
  // templates and for rows from before the editor), and the ruleset a booking
  // was made under, so the desk can count open bookings that use one. A
  // booking made before this column has null and is not counted.
  ensureColumn(db, 'rulesets', 'based_on', 'INTEGER REFERENCES rulesets(id)');
  ensureColumn(db, 'bookings', 'ruleset_id', 'INTEGER REFERENCES rulesets(id)');
```

- [ ] **Step 4: Store the ruleset id on a new booking**

In `src/bookings/bookings.ts`, in `interface BookingRow`, after the line `cancelled_by: string | null; cancel_side: Side | null; cancel_reason: string | null;` add:

```ts
  /** The ruleset the booking was made under; null for one made before the
   *  Rulesets editor. rules_json is the snapshot the booking plays by. */
  ruleset_id: number | null;
```

Replace the whole `pickRules` function with:

```ts
/** The ruleset a booking is made under: its id (kept on the booking so the
 *  Rulesets desk can count it) and the scrim snapshot of its rules. */
function pickRules(db: DB, raw: unknown): { id: number; json: string } | null {
  const row = (raw === undefined || raw === null
    ? db.prepare("SELECT id, rules_json FROM rulesets WHERE name = 'Casual Scrim' AND archived_at IS NULL").get()
    : Number.isInteger(raw)
      ? db.prepare('SELECT id, rules_json FROM rulesets WHERE id = ? AND archived_at IS NULL').get(raw)
      : undefined) as { id: number; rules_json: string } | undefined;
  if (!row) return null;
  try {
    return { id: row.id, json: JSON.stringify(rulesForKind('scrim', parseRules(row.rules_json))) };
  } catch {
    return null;
  }
}
```

In `createBooking`, replace the insert

```ts
      `INSERT INTO bookings (purpose, region, starts_at, ends_at, password, tv_password, game_config, rules_json, playlist_json, games_allowed, created_by, created_at)
       VALUES ('scrim', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(region, iso(startMs), iso(endMs), newLeasePassword(), newLeasePassword(), config, rules, JSON.stringify(playlist), playlist.length,
      o.by, now.toISOString()).lastInsertRowid);
```

with

```ts
      `INSERT INTO bookings (purpose, region, starts_at, ends_at, password, tv_password, game_config, rules_json, ruleset_id, playlist_json, games_allowed, created_by, created_at)
       VALUES ('scrim', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(region, iso(startMs), iso(endMs), newLeasePassword(), newLeasePassword(), config, rules.json, rules.id, JSON.stringify(playlist), playlist.length,
      o.by, now.toISOString()).lastInsertRowid);
```

(`if (!rules) return fail('bad_ruleset');` above it stays as it is.)

- [ ] **Step 5: Add the summary**

Append to `src/events/format.ts`:

```ts
const SIDE_SHORT: Record<MatchRules['sideRule'], string> = {
  higher_seed_chooses: 'higher seed picks sides',
  non_picker_chooses: 'non-picker picks sides',
  coin: 'coin toss for sides',
};

/** A ruleset in one line, for a picker's help text and the Rulesets desk:
 *  the pauses, how sides are chosen and the no-show grace. */
export function rulesSummary(r: MatchRules): string {
  const each = r.pause.seconds === null ? '' : ` of ${r.pause.seconds} s`;
  const pauses = r.pause.limit === null
    ? `Unlimited pauses${each}`
    : r.pause.limit === 0 ? 'No pauses' : `${r.pause.limit} pause${r.pause.limit === 1 ? '' : 's'}${each}`;
  return `${pauses} · ${SIDE_SHORT[r.sideRule]} · ${r.noShowGraceMinutes} min no-show grace`;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/eventFormat.test.ts tests/rulesets.test.ts tests/bookings.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/db.ts src/bookings/bookings.ts src/events/format.ts tests/eventFormat.test.ts tests/rulesets.test.ts tests/bookings.test.ts
git commit -m "Rulesets: a booking keeps the ruleset it was made under, a copy keeps its source, and a ruleset reads in one line"
```

---

### Task 2: The ruleset store

**Files:**
- Create: `src/rulesetStore.ts`
- Test: `tests/rulesetStore.test.ts` (new)

**Interfaces:**
- Consumes: `parseRules`, `MatchRules` (`src/rulesets.ts`); `rulesSummary` (Task 1); `OPEN_STATES_SQL` (`src/bookings/rules.ts`); `logAdmin(db, adminId, action, target, detail)` (`src/admin/audit.ts`); test fixture `eventFixture`, `ADMIN`, `must` (`tests/eventFixture.ts`).
- Produces (later tasks rely on these exact names):
  - `RULESET_ERRORS: Record<RulesetError, { status: number; text: string }>`, `type RulesetError`, `type RulesetResult<T> = { ok: true; value: T } | { ok: false; error: RulesetError }`
  - `type EditableRules = Omit<MatchRules, 'rated' | 'penalties'>`
  - `interface RulesetListItem { id: number; name: string; template: boolean; basedOn: string | null; readOnly: boolean; archived: boolean; summary: string; rules: MatchRules | null; inUse: { bookings: number; events: number } }`
  - `rulesetList(db): RulesetListItem[]`
  - `createRuleset(db, { by: string; copyFrom: unknown; name: unknown; now?: Date }): RulesetResult<{ id: number }>`
  - `updateRuleset(db, { by: string; id: number; name: unknown; rules: unknown }): RulesetResult<null>`
  - `setRulesetArchived(db, { by: string; id: number; archived: boolean; now?: Date }): RulesetResult<null>`
  - `readEditableRules(raw: unknown): RulesetResult<EditableRules>`, `readRulesetName(raw: unknown): string | null`, `unratedRules(e: EditableRules): MatchRules`, `rulesetInUse(db, id)`, `getRuleset(db, id)`
  - audit actions `ruleset_create`, `ruleset_update`, `ruleset_archive`, `ruleset_unarchive`, each with the ruleset id as target.

- [ ] **Step 1: Write the failing tests**

`tests/rulesetStore.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import type { DB } from '../src/db.js';
import { TEMPLATES } from '../src/rulesets.js';
import {
  createRuleset, readEditableRules, rulesetList, setRulesetArchived, updateRuleset, type EditableRules,
} from '../src/rulesetStore.js';
import { ADMIN, eventFixture, must } from './eventFixture.js';
import * as E from '../src/events/events.js';

let db: DB;
let eventId: number;
const idOf = (name: string) => (db.prepare('SELECT id FROM rulesets WHERE name = ?').get(name) as { id: number }).id;
const row = (id: number) => db.prepare('SELECT name, rules_json, template, based_on, created_by, archived_at FROM rulesets WHERE id = ?').get(id) as {
  name: string; rules_json: string; template: number; based_on: number | null; created_by: string | null; archived_at: string | null;
};
const audit = () => db.prepare('SELECT action, target, detail FROM admin_actions ORDER BY id').all() as { action: string; target: string; detail: string }[];
const { rated: _rated, penalties: _penalties, ...cupEditable } = TEMPLATES['Standard Cup'];
const edit = (over: Partial<EditableRules> = {}): EditableRules => ({ ...cupEditable, ...over });
const okOf = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.value;
};
const errOf = (r: { ok: boolean; error?: string }) => (r.ok ? 'ok' : r.error);

beforeEach(() => {
  ({ db, eventId } = eventFixture('announced'));
});

describe('reading the editable rules', () => {
  it('takes every field and turns blank pause limits into no limit', () => {
    expect(okOf(readEditableRules(edit({ pause: { limit: null, seconds: null, mutualUnpause: false, techPauses: 0 } }))).pause)
      .toEqual({ limit: null, seconds: null, mutualUnpause: false, techPauses: 0 });
    expect(okOf(readEditableRules(edit({ pause: { limit: 0, seconds: 30, mutualUnpause: true, techPauses: 5 } }))).pause)
      .toEqual({ limit: 0, seconds: 30, mutualUnpause: true, techPauses: 5 });
  });

  it('refuses each out-of-range or mistyped field with its own reason', () => {
    const p = cupEditable.pause;
    expect(errOf(readEditableRules(edit({ pause: { ...p, limit: 11 } })))).toBe('bad_pause_limit');
    expect(errOf(readEditableRules(edit({ pause: { ...p, limit: '3' as never } })))).toBe('bad_pause_limit');
    expect(errOf(readEditableRules(edit({ pause: { ...p, limit: 1.5 } })))).toBe('bad_pause_limit');
    expect(errOf(readEditableRules(edit({ pause: { ...p, seconds: 29 } })))).toBe('bad_pause_seconds');
    expect(errOf(readEditableRules(edit({ pause: { ...p, techPauses: 6 } })))).toBe('bad_tech_pauses');
    expect(errOf(readEditableRules(edit({ noShowGraceMinutes: 4 })))).toBe('bad_grace');
    expect(errOf(readEditableRules(edit({ noShowGraceMinutes: 61 })))).toBe('bad_grace');
    expect(errOf(readEditableRules(edit({ bosses: 'sometimes' as never })))).toBe('bad_choice');
    expect(errOf(readEditableRules(edit({ sideRule: 'loser' as never })))).toBe('bad_choice');
    expect(errOf(readEditableRules(edit({ teamLock: 'yes' as never })))).toBe('bad_rules');
    expect(errOf(readEditableRules(null))).toBe('bad_rules');
    expect(errOf(readEditableRules({ ...edit(), spectate: undefined }))).toBe('bad_rules');
  });

  it('drops lockAfterDamage when a half cannot be restarted at all', () => {
    expect(okOf(readEditableRules(edit({ restartHalf: { allowed: false, lockAfterDamage: true } }))).restartHalf)
      .toEqual({ allowed: false, lockAfterDamage: false });
  });
});

describe('the ruleset list', () => {
  it('lists the templates with their summary, PUG read only, and counts what uses each', () => {
    const list = rulesetList(db);
    expect(list.map((r) => [r.name, r.template, r.readOnly, r.archived, r.basedOn])).toEqual([
      ['PUG', true, true, false, null], ['Standard Cup', true, false, false, null], ['Casual Scrim', true, false, false, null],
    ]);
    expect(list[1].summary).toBe('3 pauses of 120 s · higher seed picks sides · 15 min no-show grace');
    expect(list[1].rules).toEqual(TEMPLATES['Standard Cup']);
    // The fixture's announced event has two stages on Standard Cup: one event.
    expect(list[1].inUse).toEqual({ bookings: 0, events: 1 });
    db.prepare(
      `INSERT INTO bookings (purpose, starts_at, ends_at, password, tv_password, game_config, rules_json, ruleset_id, playlist_json, created_by, created_at)
       VALUES ('scrim', 'x', 'y', 'p', 't', 'standard', '{}', ?, '[]', ?, 'x')`,
    ).run(idOf('Casual Scrim'), ADMIN);
    db.prepare(
      `INSERT INTO bookings (purpose, starts_at, ends_at, state, password, tv_password, game_config, rules_json, ruleset_id, playlist_json, created_by, created_at)
       VALUES ('scrim', 'x', 'y', 'ended', 'p', 't', 'standard', '{}', ?, '[]', ?, 'x')`,
    ).run(idOf('Casual Scrim'), ADMIN);
    expect(rulesetList(db)[2].inUse).toEqual({ bookings: 1, events: 0 });
    must(E.cancelEvent(db, { eventId, by: ADMIN, reason: 'rain' }));
    expect(rulesetList(db)[1].inUse).toEqual({ bookings: 0, events: 0 });
  });
});

describe('creating a ruleset', () => {
  it('copies the chosen ruleset under a new name, unrated and without penalties, and audits it', () => {
    const { id } = okOf(createRuleset(db, { by: ADMIN, copyFrom: idOf('PUG'), name: '  League Night  ' }));
    const r = row(id);
    expect(r).toMatchObject({ name: 'League Night', template: 0, based_on: idOf('PUG'), created_by: ADMIN, archived_at: null });
    expect(JSON.parse(r.rules_json)).toEqual({ ...TEMPLATES.PUG, rated: false, penalties: false });
    expect(rulesetList(db).find((x) => x.id === id)!.basedOn).toBe('PUG');
    const [a] = audit();
    expect(a).toMatchObject({ action: 'ruleset_create', target: String(id) });
    expect(JSON.parse(a.detail)).toMatchObject({ copyFrom: { id: idOf('PUG'), name: 'PUG' }, after: { name: 'League Night' } });
  });

  it('refuses a missing source, a bad name and a name taken in any case, writing nothing', () => {
    expect(errOf(createRuleset(db, { by: ADMIN, copyFrom: 999, name: 'Fine name' }))).toBe('not_found');
    expect(errOf(createRuleset(db, { by: ADMIN, copyFrom: '2', name: 'Fine name' }))).toBe('not_found');
    expect(errOf(createRuleset(db, { by: ADMIN, copyFrom: idOf('PUG'), name: 'ab' }))).toBe('bad_name');
    expect(errOf(createRuleset(db, { by: ADMIN, copyFrom: idOf('PUG'), name: 'x'.repeat(41) }))).toBe('bad_name');
    expect(errOf(createRuleset(db, { by: ADMIN, copyFrom: idOf('PUG'), name: 'bad\nname' }))).toBe('bad_name');
    expect(errOf(createRuleset(db, { by: ADMIN, copyFrom: idOf('PUG'), name: 'casual SCRIM' }))).toBe('name_taken');
    expect(db.prepare('SELECT COUNT(*) AS n FROM rulesets').get()).toEqual({ n: 3 });
    expect(audit()).toEqual([]);
  });
});

describe('editing a ruleset', () => {
  it('saves the rules unrated with before and after in the audit row', () => {
    const { id } = okOf(createRuleset(db, { by: ADMIN, copyFrom: idOf('Casual Scrim'), name: 'Late Scrim' }));
    const rules = edit({ noShowGraceMinutes: 30, sideRule: 'coin' });
    okOf(updateRuleset(db, { by: ADMIN, id, name: 'Later Scrim', rules: { ...rules, rated: true, penalties: true } }));
    expect(row(id).name).toBe('Later Scrim');
    expect(JSON.parse(row(id).rules_json)).toEqual({ ...rules, rated: false, penalties: false });
    const last = audit().at(-1)!;
    expect(last.action).toBe('ruleset_update');
    const detail = JSON.parse(last.detail);
    expect(detail.before).toEqual({ name: 'Late Scrim', rules: TEMPLATES['Casual Scrim'] });
    expect(detail.after.name).toBe('Later Scrim');
    expect(detail.after.rules.noShowGraceMinutes).toBe(30);
  });

  it('PUG is read only, a template keeps its name, and a name cannot clash', () => {
    const before = row(idOf('PUG')).rules_json;
    expect(errOf(updateRuleset(db, { by: ADMIN, id: idOf('PUG'), name: 'PUG', rules: edit() }))).toBe('read_only');
    expect(row(idOf('PUG')).rules_json).toBe(before);
    expect(errOf(updateRuleset(db, { by: ADMIN, id: idOf('Standard Cup'), name: 'Cup', rules: edit() }))).toBe('template_locked');
    expect(errOf(updateRuleset(db, { by: ADMIN, id: idOf('Standard Cup'), name: 'Standard Cup', rules: edit({ noShowGraceMinutes: 2 }) }))).toBe('bad_grace');
    const { id } = okOf(createRuleset(db, { by: ADMIN, copyFrom: idOf('PUG'), name: 'Mine' }));
    expect(errOf(updateRuleset(db, { by: ADMIN, id, name: 'standard cup', rules: edit() }))).toBe('name_taken');
    expect(errOf(updateRuleset(db, { by: ADMIN, id: 999, name: 'Whatever', rules: edit() }))).toBe('not_found');
    expect(audit().map((a) => a.action)).toEqual(['ruleset_create']);
  });

  it('a template may change its rules under its own name', () => {
    okOf(updateRuleset(db, { by: ADMIN, id: idOf('Standard Cup'), name: 'Standard Cup', rules: edit({ noShowGraceMinutes: 20 }) }));
    expect(JSON.parse(row(idOf('Standard Cup')).rules_json).noShowGraceMinutes).toBe(20);
  });

  it('never touches the copy a published stage or a booking already took', () => {
    const stagesBefore = db.prepare('SELECT id, rules_json FROM event_stages WHERE event_id = ? ORDER BY id').all(eventId);
    db.prepare(
      `INSERT INTO bookings (purpose, starts_at, ends_at, password, tv_password, game_config, rules_json, ruleset_id, playlist_json, created_by, created_at)
       VALUES ('scrim', 'x', 'y', 'p', 't', 'standard', ?, ?, '[]', ?, 'x')`,
    ).run(JSON.stringify(TEMPLATES['Standard Cup']), idOf('Standard Cup'), ADMIN);
    okOf(updateRuleset(db, { by: ADMIN, id: idOf('Standard Cup'), name: 'Standard Cup', rules: edit({ noShowGraceMinutes: 45 }) }));
    expect(db.prepare('SELECT id, rules_json FROM event_stages WHERE event_id = ? ORDER BY id').all(eventId)).toEqual(stagesBefore);
    expect(JSON.parse((db.prepare('SELECT rules_json FROM bookings').get() as { rules_json: string }).rules_json).noShowGraceMinutes).toBe(15);
  });
});

describe('archiving a ruleset', () => {
  it('hides a copy and brings it back, keeping the first archive time, audited both ways', () => {
    const { id } = okOf(createRuleset(db, { by: ADMIN, copyFrom: idOf('PUG'), name: 'Old Rules' }));
    okOf(setRulesetArchived(db, { by: ADMIN, id, archived: true, now: new Date('2026-10-01T12:00:00.000Z') }));
    okOf(setRulesetArchived(db, { by: ADMIN, id, archived: true, now: new Date('2026-10-02T12:00:00.000Z') }));
    expect(row(id).archived_at).toBe('2026-10-01T12:00:00.000Z');
    expect(rulesetList(db).at(-1)).toMatchObject({ id, archived: true });
    okOf(setRulesetArchived(db, { by: ADMIN, id, archived: false }));
    expect(row(id).archived_at).toBeNull();
    expect(audit().map((a) => a.action)).toEqual(['ruleset_create', 'ruleset_archive', 'ruleset_archive', 'ruleset_unarchive']);
    expect(JSON.parse(audit()[1].detail)).toEqual({ name: 'Old Rules', before: { archivedAt: null }, after: { archivedAt: '2026-10-01T12:00:00.000Z' } });
  });

  it('never archives a template', () => {
    for (const name of ['PUG', 'Standard Cup', 'Casual Scrim']) {
      expect(errOf(setRulesetArchived(db, { by: ADMIN, id: idOf(name), archived: true }))).toBe('template_locked');
    }
    expect(errOf(setRulesetArchived(db, { by: ADMIN, id: 999, archived: true }))).toBe('not_found');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/rulesetStore.test.ts`
Expected: FAIL with `Cannot find module '../src/rulesetStore.js'`.

- [ ] **Step 3: Write the store**

`src/rulesetStore.ts`:

```ts
import type { DB } from './db.js';
import { parseRules, type MatchRules } from './rulesets.js';
import { rulesSummary } from './events/format.js';
import { OPEN_STATES_SQL } from './bookings/rules.js';
import { logAdmin } from './admin/audit.js';

/**
 * The Rulesets desk's reads and every write to the rulesets table after the
 * templates are seeded (src/rulesets.ts seedRulesetTemplates).
 *
 * Each write is one better-sqlite3 transaction that re-reads the row, checks,
 * writes and adds its logAdmin row with the before and after, so the audit
 * row cannot be missing for a write that landed. Bookings and event stages
 * keep their own copy of the rules (bookings.rules_json, event_stages.
 * rules_json), so nothing here ever touches them: an edit applies to the
 * next booking or publish only.
 *
 * PUG is read only: it mirrors the live PUG cfg, and it is the only ruleset
 * that is rated or has penalties. Every other ruleset is written with rated
 * and penalties false whatever is sent. The three templates keep their
 * names and are never archived, because code finds them by name (the
 * booking default 'Casual Scrim', the event default 'Standard Cup') and the
 * seed would add a renamed one back on the next start.
 */

export const RULESET_ERRORS = {
  not_found: { status: 404, text: 'No such ruleset.' },
  read_only: { status: 409, text: 'The PUG ruleset mirrors the live PUG config and cannot be changed here.' },
  template_locked: { status: 409, text: 'A built-in ruleset keeps its name and cannot be archived.' },
  bad_name: { status: 400, text: 'A name is 3 to 40 characters.' },
  name_taken: { status: 409, text: 'Another ruleset already has that name.' },
  bad_rules: { status: 400, text: 'Every rule needs a value.' },
  bad_pause_limit: { status: 400, text: 'Pauses per team is a whole number from 0 to 10, or blank for no limit.' },
  bad_pause_seconds: { status: 400, text: 'Pause length is 30 to 600 seconds, or blank for no limit.' },
  bad_tech_pauses: { status: 400, text: 'Technical pauses is a whole number from 0 to 5.' },
  bad_grace: { status: 400, text: 'No-show grace is 5 to 60 minutes.' },
  bad_choice: { status: 400, text: 'Pick one of the listed options.' },
} as const satisfies Record<string, { status: number; text: string }>;
export type RulesetError = keyof typeof RULESET_ERRORS;
export type RulesetResult<T> = { ok: true; value: T } | { ok: false; error: RulesetError };
const ok = <T>(value: T): RulesetResult<T> => ({ ok: true, value });
const fail = (error: RulesetError): { ok: false; error: RulesetError } => ({ ok: false, error });

/** What the editor may change: everything but rated and penalties. */
export type EditableRules = Omit<MatchRules, 'rated' | 'penalties'>;

export interface RulesetRow {
  id: number; name: string; rules_json: string; template: number; based_on: number | null;
  created_by: string | null; created_at: string; archived_at: string | null;
}

export interface RulesetListItem {
  id: number; name: string; template: boolean; basedOn: string | null; readOnly: boolean; archived: boolean;
  summary: string; rules: MatchRules | null; inUse: { bookings: number; events: number };
}

const BOSSES: readonly MatchRules['bosses'][] = ['random_published', 'fixed', 'voteboss'];
const SIDE_RULES: readonly MatchRules['sideRule'][] = ['higher_seed_chooses', 'non_picker_chooses', 'coin'];
export const NAME_MIN = 3;
export const NAME_MAX = 40;

const isPug = (r: Pick<RulesetRow, 'template' | 'name'>): boolean => r.template === 1 && r.name === 'PUG';
const whole = (v: unknown, min: number, max: number): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

export function getRuleset(db: DB, id: number): RulesetRow | undefined {
  return db.prepare('SELECT * FROM rulesets WHERE id = ?').get(id) as RulesetRow | undefined;
}

function rulesOf(row: RulesetRow): MatchRules | null {
  try { return parseRules(row.rules_json); } catch { return null; }
}

/** Open bookings made under it, and events not finished or cancelled with a stage on it. */
export function rulesetInUse(db: DB, id: number): { bookings: number; events: number } {
  const bookings = (db.prepare(`SELECT COUNT(*) AS n FROM bookings WHERE ruleset_id = ? AND state IN ${OPEN_STATES_SQL}`).get(id) as { n: number }).n;
  const events = (db.prepare(
    `SELECT COUNT(DISTINCT e.id) AS n FROM event_stages s JOIN events e ON e.id = s.event_id
     WHERE s.ruleset_id = ? AND e.status NOT IN ('finished', 'cancelled')`,
  ).get(id) as { n: number }).n;
  return { bookings, events };
}

export function rulesetList(db: DB): RulesetListItem[] {
  const rows = db.prepare('SELECT * FROM rulesets ORDER BY archived_at IS NOT NULL, id').all() as RulesetRow[];
  const names = new Map(rows.map((r) => [r.id, r.name]));
  return rows.map((r) => {
    const rules = rulesOf(r);
    return {
      id: r.id, name: r.name, template: r.template === 1, basedOn: r.based_on === null ? null : names.get(r.based_on) ?? null,
      readOnly: isPug(r), archived: r.archived_at !== null, summary: rules ? rulesSummary(rules) : '', rules, inUse: rulesetInUse(db, r.id),
    };
  });
}

/** Trimmed, 3 to 40 characters, no control characters. */
export function readRulesetName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  if (name.length < NAME_MIN || name.length > NAME_MAX || /[\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}

/** The editable fields from a request body, checked by hand like parseRules,
 *  each range refused with its own sentence. Blank pause limit or length is
 *  null (no limit), never 0. */
export function readEditableRules(raw: unknown): RulesetResult<EditableRules> {
  if (typeof raw !== 'object' || raw === null) return fail('bad_rules');
  const r = raw as Record<string, unknown>;
  const pause = r.pause as Record<string, unknown> | null | undefined;
  const restartHalf = r.restartHalf as Record<string, unknown> | null | undefined;
  const spectate = r.spectate as Record<string, unknown> | null | undefined;
  if (typeof pause !== 'object' || pause === null || typeof restartHalf !== 'object' || restartHalf === null
    || typeof spectate !== 'object' || spectate === null) return fail('bad_rules');
  if (pause.limit !== null && !whole(pause.limit, 0, 10)) return fail('bad_pause_limit');
  if (pause.seconds !== null && !whole(pause.seconds, 30, 600)) return fail('bad_pause_seconds');
  if (!whole(pause.techPauses, 0, 5)) return fail('bad_tech_pauses');
  if (!whole(r.noShowGraceMinutes, 5, 60)) return fail('bad_grace');
  if (!BOSSES.includes(r.bosses as MatchRules['bosses']) || !SIDE_RULES.includes(r.sideRule as MatchRules['sideRule'])) return fail('bad_choice');
  for (const b of [pause.mutualUnpause, r.teamLock, r.playerMapControl, restartHalf.allowed, restartHalf.lockAfterDamage, spectate.sideLocked]) {
    if (typeof b !== 'boolean') return fail('bad_rules');
  }
  return ok({
    pause: { limit: pause.limit as number | null, seconds: pause.seconds as number | null, mutualUnpause: pause.mutualUnpause as boolean, techPauses: pause.techPauses as number },
    teamLock: r.teamLock as boolean,
    playerMapControl: r.playerMapControl as boolean,
    restartHalf: { allowed: restartHalf.allowed as boolean, lockAfterDamage: (restartHalf.allowed as boolean) && (restartHalf.lockAfterDamage as boolean) },
    noShowGraceMinutes: r.noShowGraceMinutes as number,
    bosses: r.bosses as MatchRules['bosses'],
    sideRule: r.sideRule as MatchRules['sideRule'],
    spectate: { sideLocked: spectate.sideLocked as boolean },
  });
}

/** A non-PUG ruleset as stored: never rated, never penalties, in MatchRules
 *  field order so the JSON reads the same as the seeded templates. */
export function unratedRules(e: EditableRules): MatchRules {
  return {
    rated: false, pause: e.pause, teamLock: e.teamLock, playerMapControl: e.playerMapControl, restartHalf: e.restartHalf,
    noShowGraceMinutes: e.noShowGraceMinutes, penalties: false, bosses: e.bosses, sideRule: e.sideRule, spectate: e.spectate,
  };
}

function nameTaken(db: DB, name: string, exceptId: number | null): boolean {
  const key = name.toLowerCase();
  return (db.prepare('SELECT id, name FROM rulesets').all() as { id: number; name: string }[])
    .some((r) => r.id !== exceptId && r.name.toLowerCase() === key);
}

/** A new ruleset copied from an existing one (archived ones too), under a
 *  new unique name. A copy of PUG is unrated and has no penalties. */
export function createRuleset(db: DB, o: { by: string; copyFrom: unknown; name: unknown; now?: Date }): RulesetResult<{ id: number }> {
  const now = o.now ?? new Date();
  return db.transaction((): RulesetResult<{ id: number }> => {
    const source = Number.isInteger(o.copyFrom) ? getRuleset(db, o.copyFrom as number) : undefined;
    if (!source) return fail('not_found');
    const rules = rulesOf(source);
    if (!rules) return fail('bad_rules');
    const name = readRulesetName(o.name);
    if (!name) return fail('bad_name');
    if (nameTaken(db, name, null)) return fail('name_taken');
    const { rated: _r, penalties: _p, ...editable } = rules;
    const json = JSON.stringify(unratedRules(editable));
    const id = Number(db.prepare(
      'INSERT INTO rulesets (name, rules_json, template, based_on, created_by, created_at) VALUES (?, ?, 0, ?, ?, ?)',
    ).run(name, json, source.id, o.by, now.toISOString()).lastInsertRowid);
    logAdmin(db, o.by, 'ruleset_create', id, { copyFrom: { id: source.id, name: source.name }, after: { name, rules: JSON.parse(json) } });
    return ok({ id });
  })();
}

/** Change a ruleset's name and rules. PUG is refused; a template keeps its name. */
export function updateRuleset(db: DB, o: { by: string; id: number; name: unknown; rules: unknown }): RulesetResult<null> {
  return db.transaction((): RulesetResult<null> => {
    const row = getRuleset(db, o.id);
    if (!row) return fail('not_found');
    if (isPug(row)) return fail('read_only');
    const name = readRulesetName(o.name);
    if (!name) return fail('bad_name');
    if (row.template === 1 && name !== row.name) return fail('template_locked');
    if (nameTaken(db, name, row.id)) return fail('name_taken');
    const edited = readEditableRules(o.rules);
    if (!edited.ok) return edited;
    const json = JSON.stringify(unratedRules(edited.value));
    db.prepare('UPDATE rulesets SET name = ?, rules_json = ? WHERE id = ?').run(name, json, row.id);
    logAdmin(db, o.by, 'ruleset_update', row.id, {
      before: { name: row.name, rules: rulesOf(row) }, after: { name, rules: JSON.parse(json) },
    });
    return ok(null);
  })();
}

/** Archive (hide from every picker) or bring back. A booking or stage that
 *  already uses it keeps its copy; a draft stage on it is refused at publish. */
export function setRulesetArchived(db: DB, o: { by: string; id: number; archived: boolean; now?: Date }): RulesetResult<null> {
  const now = o.now ?? new Date();
  return db.transaction((): RulesetResult<null> => {
    const row = getRuleset(db, o.id);
    if (!row) return fail('not_found');
    if (row.template === 1) return fail('template_locked');
    const archivedAt = o.archived ? row.archived_at ?? now.toISOString() : null;
    db.prepare('UPDATE rulesets SET archived_at = ? WHERE id = ?').run(archivedAt, row.id);
    logAdmin(db, o.by, o.archived ? 'ruleset_archive' : 'ruleset_unarchive', row.id, {
      name: row.name, before: { archivedAt: row.archived_at }, after: { archivedAt },
    });
    return ok(null);
  })();
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/rulesetStore.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/rulesetStore.ts tests/rulesetStore.test.ts
git commit -m "Rulesets: copy, edit and archive a ruleset in one audited transaction; PUG read only, built-ins keep their names"
```

---

### Task 3: The game config store

**Files:**
- Create: `src/gameConfigStore.ts`
- Test: `tests/gameConfigStore.test.ts` (new)

**Interfaces:**
- Consumes: `OPEN_STATES_SQL` (`src/bookings/rules.ts`); `logAdmin` (`src/admin/audit.ts`); `eventFixture`, `ADMIN`, `must` (`tests/eventFixture.ts`); `E.deleteDraftEvent(db, { eventId, by })` (`src/events/events.ts`).
- Produces:
  - `GAME_CONFIG_ERRORS`, `type GameConfigError`, `type GameConfigResult<T>`
  - `interface GameConfigListItem { key: string; label: string; cfg: string; enabled: boolean; locked: boolean; inUse: { bookings: number; events: number } }`
  - `gameConfigList(db): GameConfigListItem[]` (standard first)
  - `createGameConfig(db, { by: string; key: unknown; label: unknown; cfg: unknown }): GameConfigResult<{ key: string }>`
  - `updateGameConfig(db, { by: string; key: string; label: unknown; enabled: unknown }): GameConfigResult<null>`
  - `deleteGameConfig(db, { by: string; key: string }): GameConfigResult<null>`
  - `KEY_RE`, `CFG_RE`; audit actions `game_config_create`, `game_config_update`, `game_config_delete`, each with the key as target.

- [ ] **Step 1: Write the failing tests**

`tests/gameConfigStore.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import type { DB } from '../src/db.js';
import { createGameConfig, deleteGameConfig, gameConfigList, updateGameConfig } from '../src/gameConfigStore.js';
import { ADMIN, eventFixture, must } from './eventFixture.js';
import * as E from '../src/events/events.js';

let db: DB;
let eventId: number;
let s1: number;
const errOf = (r: { ok: boolean; error?: string }) => (r.ok ? 'ok' : r.error);
const done = (r: { ok: boolean; error?: string }) => { if (!r.ok) throw new Error(`expected ok, got ${r.error}`); };
const audit = () => db.prepare('SELECT action, target, detail FROM admin_actions ORDER BY id').all() as { action: string; target: string; detail: string }[];
const configs = () => db.prepare('SELECT key, label, cfg, enabled FROM game_configs ORDER BY key').all();

beforeEach(() => {
  ({ db, eventId, s1 } = eventFixture('draft'));
});

describe('game configs', () => {
  it('adds a config, enabled, with the cfg setup will exec, and audits it', () => {
    expect(errOf(createGameConfig(db, { by: ADMIN, key: 'zonemod', label: 'ZoneMod 4v4', cfg: 'zonemod_4v4' }))).toBe('ok');
    expect(configs()).toEqual([
      { key: 'standard', label: 'Standard (Rotoblin PUG 4v4)', cfg: 'pug_match', enabled: 1 },
      { key: 'zonemod', label: 'ZoneMod 4v4', cfg: 'zonemod_4v4', enabled: 1 },
    ]);
    expect(audit()).toEqual([{ action: 'game_config_create', target: 'zonemod', detail: JSON.stringify({ after: { label: 'ZoneMod 4v4', cfg: 'zonemod_4v4', enabled: true } }) }]);
  });

  it('refuses a key, label or cfg outside the rules, and a key that exists', () => {
    const add = (over: Record<string, unknown>) => errOf(createGameConfig(db, { by: ADMIN, key: 'zonemod', label: 'ZoneMod 4v4', cfg: 'zonemod_4v4', ...over }));
    expect(add({ key: 'z' })).toBe('bad_key');
    expect(add({ key: 'ZoneMod' })).toBe('bad_key');
    expect(add({ key: 'zone-mod' })).toBe('bad_key');
    expect(add({ key: 'z'.repeat(33) })).toBe('bad_key');
    expect(add({ label: 'zm' })).toBe('bad_label');
    expect(add({ label: 'x'.repeat(61) })).toBe('bad_label');
    expect(add({ cfg: 'zonemod.cfg' })).toBe('bad_cfg');
    expect(add({ cfg: 'pug_match; quit' })).toBe('bad_cfg');
    expect(add({ cfg: '../server' })).toBe('bad_cfg');
    expect(add({ cfg: '' })).toBe('bad_cfg');
    expect(add({ key: 'standard' })).toBe('key_taken');
    expect(configs()).toHaveLength(1);
    expect(audit()).toEqual([]);
  });

  it('renames and turns a config off and on, with before and after; standard stays on', () => {
    done(createGameConfig(db, { by: ADMIN, key: 'zonemod', label: 'ZoneMod 4v4', cfg: 'zonemod_4v4' }));
    expect(errOf(updateGameConfig(db, { by: ADMIN, key: 'zonemod', label: 'ZoneMod (test)', enabled: false }))).toBe('ok');
    expect(db.prepare("SELECT label, enabled FROM game_configs WHERE key = 'zonemod'").get()).toEqual({ label: 'ZoneMod (test)', enabled: 0 });
    expect(JSON.parse(audit()[1].detail)).toEqual({
      before: { label: 'ZoneMod 4v4', cfg: 'zonemod_4v4', enabled: true }, after: { label: 'ZoneMod (test)', cfg: 'zonemod_4v4', enabled: false },
    });
    expect(errOf(updateGameConfig(db, { by: ADMIN, key: 'standard', label: 'Standard', enabled: false }))).toBe('standard_locked');
    expect(errOf(updateGameConfig(db, { by: ADMIN, key: 'standard', label: 'Standard', enabled: 'no' }))).toBe('bad_enabled');
    expect(errOf(updateGameConfig(db, { by: ADMIN, key: 'standard', label: 'Standard Rotoblin', enabled: true }))).toBe('ok');
    expect(errOf(updateGameConfig(db, { by: ADMIN, key: 'nope', label: 'Whatever', enabled: true }))).toBe('not_found');
  });

  it('deletes an unused config but never standard or one an open booking or unfinished event uses', () => {
    done(createGameConfig(db, { by: ADMIN, key: 'zonemod', label: 'ZoneMod 4v4', cfg: 'zonemod_4v4' }));
    done(createGameConfig(db, { by: ADMIN, key: 'spare', label: 'Spare config', cfg: 'spare' }));
    db.prepare("UPDATE event_stages SET game_config = 'zonemod' WHERE id = ?").run(s1);
    expect(gameConfigList(db).find((c) => c.key === 'zonemod')!.inUse).toEqual({ bookings: 0, events: 1 });
    expect(errOf(deleteGameConfig(db, { by: ADMIN, key: 'zonemod' }))).toBe('in_use');
    expect(errOf(deleteGameConfig(db, { by: ADMIN, key: 'standard' }))).toBe('standard_locked');
    expect(errOf(deleteGameConfig(db, { by: ADMIN, key: 'nope' }))).toBe('not_found');
    db.prepare(
      `INSERT INTO bookings (purpose, starts_at, ends_at, password, tv_password, game_config, rules_json, playlist_json, created_by, created_at)
       VALUES ('scrim', 'x', 'y', 'p', 't', 'spare', '{}', '[]', ?, 'x')`,
    ).run(ADMIN);
    expect(errOf(deleteGameConfig(db, { by: ADMIN, key: 'spare' }))).toBe('in_use');
    db.prepare("UPDATE bookings SET state = 'ended'").run();
    expect(errOf(deleteGameConfig(db, { by: ADMIN, key: 'spare' }))).toBe('ok');
    must(E.deleteDraftEvent(db, { eventId, by: ADMIN }));
    expect(errOf(deleteGameConfig(db, { by: ADMIN, key: 'zonemod' }))).toBe('ok');
    expect(configs()).toEqual([{ key: 'standard', label: 'Standard (Rotoblin PUG 4v4)', cfg: 'pug_match', enabled: 1 }]);
    expect(audit().slice(-2).map((a) => [a.action, a.target])).toEqual([['game_config_delete', 'spare'], ['game_config_delete', 'zonemod']]);
  });

  it('lists standard first and says it is locked', () => {
    done(createGameConfig(db, { by: ADMIN, key: 'alpha', label: 'Alpha config', cfg: 'alpha' }));
    expect(gameConfigList(db).map((c) => [c.key, c.locked, c.enabled])).toEqual([['standard', true, true], ['alpha', false, true]]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/gameConfigStore.test.ts`
Expected: FAIL with `Cannot find module '../src/gameConfigStore.js'`.

- [ ] **Step 3: Write the store**

`src/gameConfigStore.ts`:

```ts
import type { DB } from './db.js';
import { OPEN_STATES_SQL } from './bookings/rules.js';
import { logAdmin } from './admin/audit.js';

/**
 * The Game configs desk: the balance layers staff approve for bookings and
 * events (spec part 1, Rulesets). A config's cfg is what setup runs as
 * `exec <cfg>` on the booked box (src/bookings/runner.ts), so it is held to
 * lowercase letters, digits and underscores: nothing that could end the
 * command or name a path. The file itself must already be on every pool
 * server; this module cannot check that.
 *
 * Every write is one transaction with its logAdmin row (before and after).
 * 'standard' is the default every picker falls back to, so it is never
 * turned off or deleted. A config an open booking or an unfinished event uses
 * cannot be deleted; turning one off only takes it out of the pickers, and
 * what already uses it keeps running it.
 */

export const GAME_CONFIG_ERRORS = {
  not_found: { status: 404, text: 'No such game config.' },
  bad_key: { status: 400, text: 'A key is 2 to 32 lowercase letters, digits or underscores.' },
  key_taken: { status: 409, text: 'That key is already a game config.' },
  bad_label: { status: 400, text: 'A label is 3 to 60 characters.' },
  bad_cfg: { status: 400, text: 'A cfg name is lowercase letters, digits and underscores, without .cfg.' },
  bad_enabled: { status: 400, text: 'Enabled is on or off.' },
  standard_locked: { status: 409, text: 'The standard config cannot be turned off or deleted.' },
  in_use: { status: 409, text: 'Open bookings or unfinished events use this config, so it cannot be deleted.' },
} as const satisfies Record<string, { status: number; text: string }>;
export type GameConfigError = keyof typeof GAME_CONFIG_ERRORS;
export type GameConfigResult<T> = { ok: true; value: T } | { ok: false; error: GameConfigError };
const ok = <T>(value: T): GameConfigResult<T> => ({ ok: true, value });
const fail = (error: GameConfigError): { ok: false; error: GameConfigError } => ({ ok: false, error });

export const KEY_RE = /^[a-z0-9_]{2,32}$/;
export const CFG_RE = /^[a-z0-9_]+$/;
const CFG_MAX = 64;

export interface GameConfigRow { key: string; label: string; cfg: string; enabled: number }
export interface GameConfigListItem {
  key: string; label: string; cfg: string; enabled: boolean; locked: boolean; inUse: { bookings: number; events: number };
}

export function getGameConfig(db: DB, key: string): GameConfigRow | undefined {
  return db.prepare('SELECT * FROM game_configs WHERE key = ?').get(key) as GameConfigRow | undefined;
}

export function gameConfigInUse(db: DB, key: string): { bookings: number; events: number } {
  const bookings = (db.prepare(`SELECT COUNT(*) AS n FROM bookings WHERE game_config = ? AND state IN ${OPEN_STATES_SQL}`).get(key) as { n: number }).n;
  const events = (db.prepare(
    `SELECT COUNT(DISTINCT e.id) AS n FROM event_stages s JOIN events e ON e.id = s.event_id
     WHERE s.game_config = ? AND e.status NOT IN ('finished', 'cancelled')`,
  ).get(key) as { n: number }).n;
  return { bookings, events };
}

export function gameConfigList(db: DB): GameConfigListItem[] {
  const rows = db.prepare("SELECT * FROM game_configs ORDER BY key <> 'standard', key").all() as GameConfigRow[];
  return rows.map((r) => ({
    key: r.key, label: r.label, cfg: r.cfg, enabled: r.enabled === 1, locked: r.key === 'standard', inUse: gameConfigInUse(db, r.key),
  }));
}

function readLabel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const label = raw.trim();
  return label.length >= 3 && label.length <= 60 && !/[\u0000-\u001f\u007f]/.test(label) ? label : null;
}

const plain = (r: GameConfigRow) => ({ label: r.label, cfg: r.cfg, enabled: r.enabled === 1 });

export function createGameConfig(db: DB, o: { by: string; key: unknown; label: unknown; cfg: unknown }): GameConfigResult<{ key: string }> {
  return db.transaction((): GameConfigResult<{ key: string }> => {
    if (typeof o.key !== 'string' || !KEY_RE.test(o.key)) return fail('bad_key');
    const label = readLabel(o.label);
    if (!label) return fail('bad_label');
    if (typeof o.cfg !== 'string' || !CFG_RE.test(o.cfg) || o.cfg.length > CFG_MAX) return fail('bad_cfg');
    if (getGameConfig(db, o.key)) return fail('key_taken');
    db.prepare('INSERT INTO game_configs (key, label, cfg, enabled) VALUES (?, ?, ?, 1)').run(o.key, label, o.cfg);
    logAdmin(db, o.by, 'game_config_create', o.key, { after: { label, cfg: o.cfg, enabled: true } });
    return ok({ key: o.key });
  })();
}

/** The label and whether pickers offer it. The cfg never changes: a new cfg
 *  is a new config, so what a key meant stays readable in the audit log. */
export function updateGameConfig(db: DB, o: { by: string; key: string; label: unknown; enabled: unknown }): GameConfigResult<null> {
  return db.transaction((): GameConfigResult<null> => {
    const row = getGameConfig(db, o.key);
    if (!row) return fail('not_found');
    const label = readLabel(o.label);
    if (!label) return fail('bad_label');
    if (typeof o.enabled !== 'boolean') return fail('bad_enabled');
    if (row.key === 'standard' && !o.enabled) return fail('standard_locked');
    db.prepare('UPDATE game_configs SET label = ?, enabled = ? WHERE key = ?').run(label, o.enabled ? 1 : 0, row.key);
    logAdmin(db, o.by, 'game_config_update', row.key, { before: plain(row), after: { label, cfg: row.cfg, enabled: o.enabled } });
    return ok(null);
  })();
}

export function deleteGameConfig(db: DB, o: { by: string; key: string }): GameConfigResult<null> {
  return db.transaction((): GameConfigResult<null> => {
    const row = getGameConfig(db, o.key);
    if (!row) return fail('not_found');
    if (row.key === 'standard') return fail('standard_locked');
    const use = gameConfigInUse(db, row.key);
    if (use.bookings > 0 || use.events > 0) return fail('in_use');
    db.prepare('DELETE FROM game_configs WHERE key = ?').run(row.key);
    logAdmin(db, o.by, 'game_config_delete', row.key, { before: plain(row), after: null });
    return ok(null);
  })();
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/gameConfigStore.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/gameConfigStore.ts tests/gameConfigStore.test.ts
git commit -m "Game configs: add, relabel, turn off and delete a config in one audited transaction; standard stays on, cfg is one console word"
```

---

### Task 4: Admin routes

**Files:**
- Create: `src/routes/adminRulesets.ts`
- Modify: `src/server.ts` (import next to `import { adminEventRoutes } from './routes/adminEvents.js';`; register right after `await app.register(adminEventRoutes, { db: deps.db, store: getCommunityStore });`)
- Test: `tests/adminRulesetRoutes.test.ts` (new)

**Interfaces:**
- Consumes: everything Task 2 and Task 3 produce; `makeRequireAdmin(db)` (`src/routes/guards.ts`); test helpers `authedCookie`, `stubOrchestrator` (`tests/helpers.ts`), `buildServer` (`src/server.ts`), `addServer` (`src/serverPool.ts`).
- Produces (the web relies on these):
  - `GET /api/admin/rulesets` -> `{ rulesets: RulesetListItem[] }`
  - `POST /api/admin/rulesets` body `{ copyFrom: number, name: string }` -> `201 { id }`
  - `POST /api/admin/rulesets/:id` body `{ name: string, rules: EditableRules }` -> `{ ok: true }`
  - `POST /api/admin/rulesets/:id/archive`, `POST /api/admin/rulesets/:id/unarchive` -> `{ ok: true }`
  - `GET /api/admin/game-configs` -> `{ gameConfigs: GameConfigListItem[] }`
  - `POST /api/admin/game-configs` body `{ key, label, cfg }` -> `201 { key }`
  - `POST /api/admin/game-configs/:key` body `{ label: string, enabled: boolean }` -> `{ ok: true }`
  - `POST /api/admin/game-configs/:key/delete` -> `{ ok: true }`
  - A refusal answers `{ error: <sentence> }` with the status from the error table; a non-admin gets 403 (`admins only`), no session 401.

- [ ] **Step 1: Write the failing tests**

`tests/adminRulesetRoutes.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { addServer } from '../src/serverPool.js';
import { TEMPLATES } from '../src/rulesets.js';
import { RULESET_ERRORS } from '../src/rulesetStore.js';
import { GAME_CONFIG_ERRORS } from '../src/gameConfigStore.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

const ADMIN = '76561199000000720';
const MOD = '76561199000000721';
const P = ['76561199000000722', '76561199000000723'];
const START = new Date(Date.now() + 3 * 24 * 3_600_000);
START.setUTCMinutes(0, 0, 0);

let db: DB;
let app: FastifyInstance;
let cookies: Record<string, Record<string, string>>;

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({
    config: { ...loadConfig({}), communityDir: mkdtempSync(join(tmpdir(), 'adminrulesets-')) },
    db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {},
    bookingRcon: async () => { throw new Error('no rcon in route tests'); },
  });
  cookies = {};
  for (const id of [ADMIN, MOD, ...P]) cookies[id] = authedCookie(app, db, id);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
  db.prepare("UPDATE settings SET value = 'everyone' WHERE key = 'competitive_enabled'").run();
  db.prepare("UPDATE settings SET value = ? WHERE key = 'map_pool'").run(JSON.stringify(['no_mercy', 'death_toll']));
  for (const n of ['a', 'bb', 'ccc']) {
    const id = addServer(db, { name: n, host: 'h', port: 27014 + n.length, rconPort: 1, rconPassword: 'x' });
    db.prepare("UPDATE servers SET status = 'idle' WHERE id = ?").run(id);
  }
});
afterEach(async () => { await app.close(); });

const call = (method: 'GET' | 'POST', url: string, as?: string, payload?: object) =>
  app.inject({ method, url, cookies: as ? cookies[as] : undefined, payload });
const idOf = (name: string) => (db.prepare('SELECT id FROM rulesets WHERE name = ?').get(name) as { id: number }).id;
const { rated: _rated, penalties: _penalties, ...scrimRules } = TEMPLATES['Casual Scrim'];
const copy = async (name: string, from = idOf('Casual Scrim')) => {
  const r = await call('POST', '/api/admin/rulesets', ADMIN, { copyFrom: from, name });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as number;
};
const pickerNames = async () => ({
  bookings: (await call('GET', '/api/bookings/options', P[0])).json().rulesets.map((r: { name: string }) => r.name),
  events: (await call('GET', '/api/admin/events/options', ADMIN)).json().rulesets.map((r: { name: string }) => r.name),
});
const configKeys = async () => ({
  bookings: (await call('GET', '/api/bookings/options', P[0])).json().gameConfigs.map((g: { key: string }) => g.key),
  events: (await call('GET', '/api/admin/events/options', ADMIN)).json().gameConfigs.map((g: { key: string }) => g.key),
});

describe('the Rulesets desk routes', () => {
  it('answer admins only: a mod and a player get 403 on every read and write, a stranger 401', async () => {
    for (const as of [MOD, P[0]]) {
      for (const [method, url] of [
        ['GET', '/api/admin/rulesets'], ['POST', '/api/admin/rulesets'], ['POST', `/api/admin/rulesets/${idOf('Casual Scrim')}`],
        ['POST', `/api/admin/rulesets/${idOf('Casual Scrim')}/archive`], ['POST', `/api/admin/rulesets/${idOf('Casual Scrim')}/unarchive`],
        ['GET', '/api/admin/game-configs'], ['POST', '/api/admin/game-configs'], ['POST', '/api/admin/game-configs/standard'],
        ['POST', '/api/admin/game-configs/standard/delete'],
      ] as ['GET' | 'POST', string][]) {
        expect((await call(method, url, as, { copyFrom: idOf('PUG'), name: 'Sneaky' })).statusCode, `${as} ${url}`).toBe(403);
      }
    }
    expect((await call('GET', '/api/admin/rulesets')).statusCode).toBe(401);
    expect(db.prepare('SELECT COUNT(*) AS n FROM rulesets').get()).toEqual({ n: 3 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM admin_actions').get()).toEqual({ n: 0 });
  });

  it('lists, copies, edits, archives and unarchives, each with one audit row', async () => {
    const listed = (await call('GET', '/api/admin/rulesets', ADMIN)).json().rulesets;
    expect(listed.map((r: { name: string; readOnly: boolean }) => [r.name, r.readOnly])).toEqual([['PUG', true], ['Standard Cup', false], ['Casual Scrim', false]]);
    const id = await copy('Thursday Scrim');
    const edited = await call('POST', `/api/admin/rulesets/${id}`, ADMIN, { name: 'Thursday Scrims', rules: { ...scrimRules, noShowGraceMinutes: 20 } });
    expect(edited.statusCode, edited.body).toBe(200);
    expect((await call('POST', `/api/admin/rulesets/${id}/archive`, ADMIN)).statusCode).toBe(200);
    expect((await call('POST', `/api/admin/rulesets/${id}/unarchive`, ADMIN)).statusCode).toBe(200);
    const mine = (await call('GET', '/api/admin/rulesets', ADMIN)).json().rulesets.find((r: { id: number }) => r.id === id);
    expect(mine).toMatchObject({ name: 'Thursday Scrims', basedOn: 'Casual Scrim', archived: false, summary: 'Unlimited pauses · non-picker picks sides · 20 min no-show grace' });
    expect((db.prepare('SELECT action FROM admin_actions ORDER BY id').all() as { action: string }[]).map((a) => a.action))
      .toEqual(['ruleset_create', 'ruleset_update', 'ruleset_archive', 'ruleset_unarchive']);
  });

  it('refuses with the sentence for each reason, writing nothing', async () => {
    const pug = await call('POST', `/api/admin/rulesets/${idOf('PUG')}`, ADMIN, { name: 'PUG', rules: scrimRules });
    expect(pug.statusCode).toBe(409);
    expect(pug.json()).toEqual({ error: RULESET_ERRORS.read_only.text });
    const bad = await call('POST', `/api/admin/rulesets/${idOf('Casual Scrim')}`, ADMIN, { name: 'Casual Scrim', rules: { ...scrimRules, noShowGraceMinutes: 90 } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: RULESET_ERRORS.bad_grace.text });
    expect((await call('POST', '/api/admin/rulesets', ADMIN, { copyFrom: idOf('PUG'), name: 'pug' })).json()).toEqual({ error: RULESET_ERRORS.name_taken.text });
    expect((await call('POST', `/api/admin/rulesets/${idOf('Standard Cup')}/archive`, ADMIN)).statusCode).toBe(409);
    expect((await call('POST', '/api/admin/rulesets/abc', ADMIN, { name: 'Whatever', rules: scrimRules })).statusCode).toBe(404);
    expect(JSON.parse((db.prepare("SELECT rules_json FROM rulesets WHERE name = 'PUG'").get() as { rules_json: string }).rules_json)).toEqual(TEMPLATES.PUG);
    expect(db.prepare('SELECT COUNT(*) AS n FROM admin_actions').get()).toEqual({ n: 0 });
  });

  it('an archived ruleset leaves the booking and event pickers; a booking or stage cannot pick it; publish refuses a draft on it', async () => {
    const id = await copy('Old Rules');
    expect(await pickerNames()).toEqual({ bookings: ['PUG', 'Standard Cup', 'Casual Scrim', 'Old Rules'], events: ['PUG', 'Standard Cup', 'Casual Scrim', 'Old Rules'] });
    const ev = (await call('POST', '/api/admin/events', ADMIN, { name: 'Old Cup', startsAt: START.toISOString(), entryKind: 'team' })).json().id;
    expect((await call('POST', `/api/admin/events/${ev}/stages`, ADMIN, { type: 'single_elim', config: { thirdPlace: false }, rulesetId: id })).statusCode).toBe(200);
    await call('POST', `/api/admin/rulesets/${id}/archive`, ADMIN);
    expect(await pickerNames()).toEqual({ bookings: ['PUG', 'Standard Cup', 'Casual Scrim'], events: ['PUG', 'Standard Cup', 'Casual Scrim'] });
    const booking = await call('POST', '/api/bookings', P[0], { opponent: { steamid: P[1] }, startsAt: START.toISOString(), playlist: ['no_mercy'], rulesetId: id });
    expect(booking.statusCode).toBe(400);
    expect((await call('POST', `/api/admin/events/${ev}/stages`, ADMIN, { type: 'swiss', config: { rounds: 4 }, rulesetId: id })).statusCode).toBe(400);
    expect((await call('POST', `/api/admin/events/${ev}/publish`, ADMIN)).statusCode).toBe(400);
    expect((await call('GET', `/api/admin/events/${ev}`, ADMIN)).json().status).toBe('draft');
  });

  it('editing a ruleset leaves a booking and a published stage on the rules they took', async () => {
    const id = await copy('Snap Rules');
    const booked = await call('POST', '/api/bookings', P[0], { opponent: { steamid: P[1] }, startsAt: START.toISOString(), playlist: ['no_mercy'], rulesetId: id });
    expect(booked.statusCode, booked.body).toBe(201);
    const ev = (await call('POST', '/api/admin/events', ADMIN, { name: 'Snap Cup', startsAt: START.toISOString(), entryKind: 'team' })).json().id;
    await call('POST', `/api/admin/events/${ev}/stages`, ADMIN, { type: 'single_elim', config: { thirdPlace: false }, rulesetId: id });
    expect((await call('POST', `/api/admin/events/${ev}/publish`, ADMIN)).statusCode).toBe(200);
    const bookingBefore = db.prepare('SELECT rules_json, ruleset_id FROM bookings WHERE id = ?').get(booked.json().id);
    const stageBefore = db.prepare('SELECT rules_json FROM event_stages WHERE event_id = ?').get(ev);
    expect((await call('GET', '/api/admin/rulesets', ADMIN)).json().rulesets.find((r: { id: number }) => r.id === id).inUse).toEqual({ bookings: 1, events: 1 });

    const r = await call('POST', `/api/admin/rulesets/${id}`, ADMIN, {
      name: 'Snap Rules', rules: { ...scrimRules, pause: { limit: 1, seconds: 60, mutualUnpause: false, techPauses: 0 }, noShowGraceMinutes: 5 },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(db.prepare('SELECT rules_json, ruleset_id FROM bookings WHERE id = ?').get(booked.json().id)).toEqual(bookingBefore);
    expect(db.prepare('SELECT rules_json FROM event_stages WHERE event_id = ?').get(ev)).toEqual(stageBefore);
    expect((await call('GET', `/api/bookings/${booked.json().id}`, P[0])).json().rules.noShowGraceMinutes).toBe(15);
  });
});

describe('the Game configs desk routes', () => {
  it('adds, renames, turns off and deletes a config; off leaves both pickers, standard stays', async () => {
    const add = await call('POST', '/api/admin/game-configs', ADMIN, { key: 'zonemod', label: 'ZoneMod 4v4', cfg: 'zonemod_4v4' });
    expect(add.statusCode, add.body).toBe(201);
    expect(await configKeys()).toEqual({ bookings: ['standard', 'zonemod'], events: ['standard', 'zonemod'] });
    expect((await call('POST', '/api/admin/game-configs/zonemod', ADMIN, { label: 'ZoneMod', enabled: false })).statusCode).toBe(200);
    expect(await configKeys()).toEqual({ bookings: ['standard'], events: ['standard'] });
    const list = (await call('GET', '/api/admin/game-configs', ADMIN)).json().gameConfigs;
    expect(list.map((g: { key: string; label: string; enabled: boolean; locked: boolean }) => [g.key, g.label, g.enabled, g.locked]))
      .toEqual([['standard', 'Standard (Rotoblin PUG 4v4)', true, true], ['zonemod', 'ZoneMod', false, false]]);
    expect((await call('POST', '/api/admin/game-configs/zonemod/delete', ADMIN)).statusCode).toBe(200);
    expect((await call('GET', '/api/admin/game-configs', ADMIN)).json().gameConfigs).toHaveLength(1);
    expect((db.prepare('SELECT action FROM admin_actions ORDER BY id').all() as { action: string }[]).map((a) => a.action))
      .toEqual(['game_config_create', 'game_config_update', 'game_config_delete']);
  });

  it('refuses a cfg that could be more than one console word, turning standard off, and deleting one in use', async () => {
    const bad = await call('POST', '/api/admin/game-configs', ADMIN, { key: 'evil', label: 'Evil config', cfg: 'pug_match; quit' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: GAME_CONFIG_ERRORS.bad_cfg.text });
    const off = await call('POST', '/api/admin/game-configs/standard', ADMIN, { label: 'Standard', enabled: false });
    expect(off.statusCode).toBe(409);
    expect((await call('POST', '/api/admin/game-configs/standard/delete', ADMIN)).statusCode).toBe(409);
    await call('POST', '/api/admin/game-configs', ADMIN, { key: 'zonemod', label: 'ZoneMod 4v4', cfg: 'zonemod_4v4' });
    const booked = await call('POST', '/api/bookings', P[0], { opponent: { steamid: P[1] }, startsAt: START.toISOString(), playlist: ['no_mercy'], gameConfig: 'zonemod' });
    expect(booked.statusCode, booked.body).toBe(201);
    const del = await call('POST', '/api/admin/game-configs/zonemod/delete', ADMIN);
    expect(del.statusCode).toBe(409);
    expect(del.json()).toEqual({ error: GAME_CONFIG_ERRORS.in_use.text });
    expect((await call('POST', '/api/admin/game-configs/nope', ADMIN, { label: 'Nope config', enabled: true })).statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/adminRulesetRoutes.test.ts`
Expected: FAIL: the admin routes answer 404 (`Route POST:/api/admin/rulesets not found`), so the first assertions see 404 where 403 or 201 is expected.

- [ ] **Step 3: Write the routes**

`src/routes/adminRulesets.ts`:

```ts
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { DB } from '../db.js';
import { makeRequireAdmin } from './guards.js';
import * as R from '../rulesetStore.js';
import * as G from '../gameConfigStore.js';

/**
 * Setup > Rulesets and Setup > Game configs. Admins only, reads included
 * (mods have no Setup desk). Every rule lives in src/rulesetStore.ts and
 * src/gameConfigStore.ts, which also write the logAdmin row inside the same
 * transaction; a route maps a refusal to its status and sentence.
 */
export async function adminRulesetRoutes(app: FastifyInstance, opts: { db: DB }): Promise<void> {
  const { db } = opts;
  const requireAdmin = makeRequireAdmin(db);
  const refuseRuleset = (reply: FastifyReply, error: R.RulesetError) =>
    reply.code(R.RULESET_ERRORS[error].status).send({ error: R.RULESET_ERRORS[error].text });
  const refuseConfig = (reply: FastifyReply, error: G.GameConfigError) =>
    reply.code(G.GAME_CONFIG_ERRORS[error].status).send({ error: G.GAME_CONFIG_ERRORS[error].text });
  const idOf = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
  };
  const body = (req: { body?: unknown }) => (req.body ?? {}) as Record<string, unknown>;

  app.get('/api/admin/rulesets', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return { rulesets: R.rulesetList(db) };
  });

  app.post('/api/admin/rulesets', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const b = body(req);
    const r = R.createRuleset(db, { by: me, copyFrom: b.copyFrom, name: b.name });
    if (!r.ok) return refuseRuleset(reply, r.error);
    return reply.code(201).send({ id: r.value.id });
  });

  app.post('/api/admin/rulesets/:id', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const id = idOf((req.params as { id: string }).id);
    if (id === null) return refuseRuleset(reply, 'not_found');
    const b = body(req);
    const r = R.updateRuleset(db, { by: me, id, name: b.name, rules: b.rules });
    if (!r.ok) return refuseRuleset(reply, r.error);
    return { ok: true };
  });

  for (const [path, archived] of [['archive', true], ['unarchive', false]] as const) {
    app.post(`/api/admin/rulesets/:id/${path}`, async (req, reply) => {
      const me = requireAdmin(req, reply);
      if (!me) return;
      const id = idOf((req.params as { id: string }).id);
      if (id === null) return refuseRuleset(reply, 'not_found');
      const r = R.setRulesetArchived(db, { by: me, id, archived });
      if (!r.ok) return refuseRuleset(reply, r.error);
      return { ok: true };
    });
  }

  app.get('/api/admin/game-configs', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return { gameConfigs: G.gameConfigList(db) };
  });

  app.post('/api/admin/game-configs', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const b = body(req);
    const r = G.createGameConfig(db, { by: me, key: b.key, label: b.label, cfg: b.cfg });
    if (!r.ok) return refuseConfig(reply, r.error);
    return reply.code(201).send({ key: r.value.key });
  });

  app.post('/api/admin/game-configs/:key', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const b = body(req);
    const r = G.updateGameConfig(db, { by: me, key: (req.params as { key: string }).key, label: b.label, enabled: b.enabled });
    if (!r.ok) return refuseConfig(reply, r.error);
    return { ok: true };
  });

  app.post('/api/admin/game-configs/:key/delete', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const r = G.deleteGameConfig(db, { by: me, key: (req.params as { key: string }).key });
    if (!r.ok) return refuseConfig(reply, r.error);
    return { ok: true };
  });
}
```

- [ ] **Step 4: Register them**

In `src/server.ts`, after `import { adminEventRoutes } from './routes/adminEvents.js';` add:

```ts
import { adminRulesetRoutes } from './routes/adminRulesets.js';
```

and right after `await app.register(adminEventRoutes, { db: deps.db, store: getCommunityStore });`:

```ts

  // Setup > Rulesets and Game configs (rulesets editor plan): admins only.
  await app.register(adminRulesetRoutes, { db: deps.db });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/adminRulesetRoutes.test.ts tests/adminEventRoutes.test.ts tests/bookingRoutes.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/routes/adminRulesets.ts src/server.ts tests/adminRulesetRoutes.test.ts
git commit -m "Rulesets and game configs: admin-only desk routes"
```

---

### Task 5: The Rulesets tab

**Files:**
- Modify: `web/src/api.ts` (types after the closing brace of `export interface AdminEventOptions { ... }`; calls in `adminApi` right after ``deleteEvent: (id: number) => post(`/api/admin/events/${id}/delete`),``)
- Modify: `web/src/routes/admin/adminRoutes.ts` (`SETUP_TABS`), `web/src/routes/admin/adminRoutes.test.ts`
- Modify: `web/src/routes/Admin.tsx`
- Modify: `web/src/styles/app.css` (append)
- Create: `web/src/routes/admin/rulesets/rulesDraft.ts`, `web/src/routes/admin/rulesets/RulesetForm.tsx`, `web/src/routes/admin/rulesets/AdminRulesets.tsx`
- Test: `web/src/routes/admin/rulesets/rulesDraft.test.ts`, `web/src/routes/admin/rulesets/AdminRulesets.test.tsx` (new)

**Interfaces:**
- Consumes: the Task 4 routes; `FormRow`, `FormGroup`, `ToggleRow` (`web/src/routes/admin/events/FormRow.tsx`); `readWhole(raw, label, blankIsNone)` (`web/src/routes/admin/events/wholeNumber.ts`); `useAction(reload)` returning `{ busy, error, run }` and `type Run` (`web/src/routes/admin/useAction.ts`); `useFetch(loader, deps)` (`web/src/hooks/useFetch.ts`); `Panel`, `Empty` (`web/src/components/bits.tsx`); CSS classes `stack`, `admin-list`, `teamchip`, `teamchip--cancelled`, `inlinerow`, `btn btn--ghost btn--sm`, `eventform`, `eventform--stage`, `eventform__actions`, `error`, `muted`.
- Produces:
  - in `web/src/api.ts`: `interface MatchRules`, `type EditableRules`, `interface AdminRuleset`; `adminApi.rulesets(signal?)`, `adminApi.createRuleset(copyFrom: number, name: string)`, `adminApi.updateRuleset(id: number, name: string, rules: EditableRules)`, `adminApi.archiveRuleset(id)`, `adminApi.unarchiveRuleset(id)`
  - `export function inUseText(u: { bookings: number; events: number }): string` in `AdminRulesets.tsx` (Task 6 reuses it)
  - CSS class `rulesetlist` (Task 6 reuses it)
  - the Setup tab `rulesets` at `/admin/setup/rulesets`

- [ ] **Step 1: Write the failing tests**

`web/src/routes/admin/rulesets/rulesDraft.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { MatchRules } from '../../../api';
import { editableFrom, readRules, typedFrom } from './rulesDraft';

const CUP: MatchRules = {
  rated: false,
  pause: { limit: 3, seconds: 120, mutualUnpause: true, techPauses: 2 },
  teamLock: true, playerMapControl: false, restartHalf: { allowed: false, lockAfterDamage: false },
  noShowGraceMinutes: 15, penalties: false, bosses: 'random_published', sideRule: 'higher_seed_chooses', spectate: { sideLocked: true },
};

describe('rules draft', () => {
  it('drops rated and penalties, and shows no limit as a blank field', () => {
    const e = editableFrom(CUP);
    expect('rated' in e || 'penalties' in e).toBe(false);
    expect(typedFrom(e)).toEqual({ limit: '3', seconds: '120', techPauses: '2', grace: '15' });
    expect(typedFrom({ ...e, pause: { ...e.pause, limit: null, seconds: null } })).toMatchObject({ limit: '', seconds: '' });
  });

  it('reads blank pause fields as no limit and 0 as zero', () => {
    const e = editableFrom(CUP);
    expect(readRules(e, { limit: '', seconds: ' ', techPauses: '0', grace: '20' })).toEqual({
      ok: true, value: { ...e, pause: { ...e.pause, limit: null, seconds: null, techPauses: 0 }, noShowGraceMinutes: 20 },
    });
    expect(readRules(e, { limit: '0', seconds: '60', techPauses: '1', grace: '5' })).toMatchObject({ ok: true, value: { pause: { limit: 0, seconds: 60 } } });
  });

  it('refuses a blank grace or technical pauses and anything not a whole number', () => {
    const e = editableFrom(CUP);
    expect(readRules(e, { limit: '3', seconds: '120', techPauses: '2', grace: '' })).toEqual({ ok: false, error: 'No-show grace needs a whole number.' });
    expect(readRules(e, { limit: '3', seconds: '120', techPauses: '', grace: '15' })).toEqual({ ok: false, error: 'Technical pauses needs a whole number.' });
    expect(readRules(e, { limit: '2.5', seconds: '120', techPauses: '2', grace: '15' }))
      .toEqual({ ok: false, error: 'Pauses per team needs a whole number, or leave it blank.' });
  });
});
```

`web/src/routes/admin/rulesets/AdminRulesets.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { AdminRuleset, MatchRules } from '../../../api';

const { mockAdmin, mockConfirm } = vi.hoisted(() => ({
  mockAdmin: { rulesets: vi.fn(), createRuleset: vi.fn(), updateRuleset: vi.fn(), archiveRuleset: vi.fn(), unarchiveRuleset: vi.fn() },
  mockConfirm: vi.fn(),
}));
vi.mock('../../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api')>();
  return { ...actual, adminApi: { ...actual.adminApi, ...mockAdmin } };
});
vi.mock('../../../components/Confirm', () => ({ confirm: mockConfirm }));
const { AdminRulesets } = await import('./AdminRulesets');
const { ApiError } = await import('../../../api');

const PUG_RULES: MatchRules = {
  rated: true, pause: { limit: 3, seconds: 120, mutualUnpause: false, techPauses: 0 }, teamLock: true, playerMapControl: false,
  restartHalf: { allowed: false, lockAfterDamage: false }, noShowGraceMinutes: 10, penalties: true, bosses: 'random_published',
  sideRule: 'coin', spectate: { sideLocked: false },
};
const SCRIM_RULES: MatchRules = {
  rated: false, pause: { limit: null, seconds: null, mutualUnpause: true, techPauses: 0 }, teamLock: true, playerMapControl: true,
  restartHalf: { allowed: true, lockAfterDamage: false }, noShowGraceMinutes: 15, penalties: false, bosses: 'random_published',
  sideRule: 'non_picker_chooses', spectate: { sideLocked: false },
};
const none = { bookings: 0, events: 0 };
const ROWS: AdminRuleset[] = [
  { id: 1, name: 'PUG', template: true, basedOn: null, readOnly: true, archived: false, summary: '3 pauses of 120 s · coin toss for sides · 10 min no-show grace', rules: PUG_RULES, inUse: none },
  { id: 3, name: 'Casual Scrim', template: true, basedOn: null, readOnly: false, archived: false, summary: 'Unlimited pauses · non-picker picks sides · 15 min no-show grace', rules: SCRIM_RULES, inUse: { bookings: 2, events: 1 } },
  { id: 4, name: 'Late Night', template: false, basedOn: 'Casual Scrim', readOnly: false, archived: false, summary: 'Unlimited pauses · non-picker picks sides · 15 min no-show grace', rules: SCRIM_RULES, inUse: none },
  { id: 5, name: 'Old Rules', template: false, basedOn: 'PUG', readOnly: false, archived: true, summary: '3 pauses of 120 s · coin toss for sides · 10 min no-show grace', rules: { ...PUG_RULES, rated: false, penalties: false }, inUse: none },
];
const rowOf = (name: string) => screen.getByText(name, { selector: 'strong' }).closest('li') as HTMLElement;
const within = (el: HTMLElement) => ({
  button: (name: string) => Array.from(el.querySelectorAll('button')).find((b) => b.textContent === name) ?? null,
});

afterEach(() => cleanup());
beforeEach(() => {
  for (const f of [...Object.values(mockAdmin), mockConfirm]) f.mockReset();
  mockAdmin.rulesets.mockResolvedValue({ rulesets: ROWS });
  for (const f of [mockAdmin.createRuleset, mockAdmin.updateRuleset, mockAdmin.archiveRuleset, mockAdmin.unarchiveRuleset]) f.mockResolvedValue({ ok: true });
  mockConfirm.mockResolvedValue(true);
});

describe('AdminRulesets', () => {
  it('lists each ruleset with where it came from, its summary and what uses it, and says edits never reach running games', async () => {
    render(<AdminRulesets />);
    await screen.findByText('Late Night', { selector: 'strong' });
    expect(screen.getByText('Changes apply to new bookings and events; running and finished ones keep the rules they started with.')).toBeTruthy();
    expect(rowOf('Late Night').textContent).toContain('Copy of Casual Scrim');
    expect(rowOf('Casual Scrim').textContent).toContain('Built-in');
    expect(rowOf('Casual Scrim').textContent).toContain('In use: 2 open bookings, 1 event');
    expect(rowOf('Late Night').textContent).toContain('Not in use');
    expect(rowOf('Old Rules').textContent).toContain('Archived');
    expect(within(rowOf('Casual Scrim')).button('Edit')).toBeTruthy();
    expect(screen.getAllByText('Unlimited pauses · non-picker picks sides · 15 min no-show grace')).toHaveLength(2);
  });

  it('PUG shows read only with no Edit or Archive; built-ins have no Archive; archived copies offer Unarchive', async () => {
    render(<AdminRulesets />);
    await screen.findByText('Late Night', { selector: 'strong' });
    expect(rowOf('PUG').textContent).toContain('Read only');
    expect(within(rowOf('PUG')).button('Edit')).toBeNull();
    expect(within(rowOf('PUG')).button('Archive')).toBeNull();
    expect(within(rowOf('Casual Scrim')).button('Archive')).toBeNull();
    fireEvent.click(within(rowOf('Old Rules')).button('Unarchive')!);
    await waitFor(() => expect(mockAdmin.unarchiveRuleset).toHaveBeenCalledWith(5));
  });

  it('archives a copy after asking', async () => {
    render(<AdminRulesets />);
    await screen.findByText('Late Night', { selector: 'strong' });
    fireEvent.click(within(rowOf('Late Night')).button('Archive')!);
    await waitFor(() => expect(mockAdmin.archiveRuleset).toHaveBeenCalledWith(4));
    expect(mockConfirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Archive Late Night?' }));
  });

  it('creates a copy of the chosen ruleset under the typed name', async () => {
    render(<AdminRulesets />);
    await screen.findByText('Late Night', { selector: 'strong' });
    fireEvent.change(screen.getByLabelText('Copy from'), { target: { value: '3' } });
    fireEvent.input(screen.getByLabelText('New ruleset name'), { target: { value: 'Thursday Scrims' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create copy' }));
    await waitFor(() => expect(mockAdmin.createRuleset).toHaveBeenCalledWith(3, 'Thursday Scrims'));
  });

  it('edits a copy: blank pause fields go out as no limit, rated and penalties never go out', async () => {
    render(<AdminRulesets />);
    await screen.findByText('Late Night', { selector: 'strong' });
    fireEvent.click(within(rowOf('Late Night')).button('Edit')!);
    fireEvent.input(screen.getByLabelText('Ruleset name'), { target: { value: 'Later Night' } });
    fireEvent.input(screen.getByLabelText('Pauses per team'), { target: { value: '2' } });
    fireEvent.input(screen.getByLabelText('No-show grace'), { target: { value: '20' } });
    fireEvent.change(screen.getByLabelText('Side choice'), { target: { value: 'coin' } });
    fireEvent.click(screen.getByLabelText('Only before damage'));
    fireEvent.click(screen.getByRole('button', { name: 'Save ruleset' }));
    await waitFor(() => expect(mockAdmin.updateRuleset).toHaveBeenCalled());
    const [id, name, rules] = mockAdmin.updateRuleset.mock.calls[0];
    expect([id, name]).toEqual([4, 'Later Night']);
    expect(rules).toEqual({
      pause: { limit: 2, seconds: null, mutualUnpause: true, techPauses: 0 }, teamLock: true, playerMapControl: true,
      restartHalf: { allowed: true, lockAfterDamage: true }, noShowGraceMinutes: 20, bosses: 'random_published', sideRule: 'coin',
      spectate: { sideLocked: false },
    });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save ruleset' })).toBeNull());
  });

  it('a built-in keeps its name, and a blank grace is caught before anything is sent', async () => {
    render(<AdminRulesets />);
    await screen.findByText('Late Night', { selector: 'strong' });
    fireEvent.click(within(rowOf('Casual Scrim')).button('Edit')!);
    expect((screen.getByLabelText('Ruleset name') as HTMLInputElement).disabled).toBe(true);
    fireEvent.input(screen.getByLabelText('No-show grace'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save ruleset' }));
    expect(await screen.findByText('No-show grace needs a whole number.')).toBeTruthy();
    expect(mockAdmin.updateRuleset).not.toHaveBeenCalled();
  });

  it('a refusal keeps the form open and shows the reason', async () => {
    mockAdmin.updateRuleset.mockRejectedValue(new ApiError(409, 'Another ruleset already has that name.'));
    render(<AdminRulesets />);
    await screen.findByText('Late Night', { selector: 'strong' });
    fireEvent.click(within(rowOf('Late Night')).button('Edit')!);
    fireEvent.input(screen.getByLabelText('Ruleset name'), { target: { value: 'casual scrim' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save ruleset' }));
    expect(await screen.findByText('Another ruleset already has that name.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save ruleset' })).toBeTruthy();
  });
});
```

In `web/src/routes/admin/adminRoutes.test.ts`, inside `it('leaves room for the other two desks', ...)`, after the `/admin/setup/campaigns` line, add:

```ts
    expect(parseAdminPath('/admin/setup/rulesets', asAdmin)).toEqual({ desk: 'setup', section: 'rulesets', param: null });
    expect(parseAdminPath('/admin/setup/rulesets', asMod)).toEqual({ desk: 'people', section: 'search', param: null });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run web/src/routes/admin/rulesets web/src/routes/admin/adminRoutes.test.ts`
Expected: FAIL: `Failed to resolve import "./rulesDraft"` and `"./AdminRulesets"`, and `/admin/setup/rulesets` parses as `section: 'unknown'`.

- [ ] **Step 3: Add the API types and calls**

In `web/src/api.ts`, right after the closing `}` of `export interface AdminEventOptions`:

```ts
/** Mirrors src/rulesets.ts MatchRules. */
export interface MatchRules {
  rated: boolean;
  pause: { limit: number | null; seconds: number | null; mutualUnpause: boolean; techPauses: number };
  teamLock: boolean;
  playerMapControl: boolean;
  restartHalf: { allowed: boolean; lockAfterDamage: boolean };
  noShowGraceMinutes: number;
  penalties: boolean;
  bosses: 'random_published' | 'fixed' | 'voteboss';
  sideRule: 'higher_seed_chooses' | 'non_picker_chooses' | 'coin';
  spectate: { sideLocked: boolean };
}
/** What the Rulesets editor sends: everything but rated and penalties,
 *  which the server sets to false on every ruleset but PUG. */
export type EditableRules = Omit<MatchRules, 'rated' | 'penalties'>;
/** Mirrors src/rulesetStore.ts RulesetListItem. */
export interface AdminRuleset {
  id: number; name: string; template: boolean; basedOn: string | null; readOnly: boolean; archived: boolean;
  summary: string; rules: MatchRules | null; inUse: { bookings: number; events: number };
}
```

In `export const adminApi = {`, right after the line ``deleteEvent: (id: number) => post(`/api/admin/events/${id}/delete`),``:

```ts
  /** Setup > Rulesets and Game configs (rulesets editor plan). */
  rulesets: (signal?: AbortSignal) => get<{ rulesets: AdminRuleset[] }>('/api/admin/rulesets', signal),
  createRuleset: (copyFrom: number, name: string) => post<{ id: number }>('/api/admin/rulesets', { copyFrom, name }),
  updateRuleset: (id: number, name: string, rules: EditableRules) => post(`/api/admin/rulesets/${id}`, { name, rules }),
  archiveRuleset: (id: number) => post(`/api/admin/rulesets/${id}/archive`),
  unarchiveRuleset: (id: number) => post(`/api/admin/rulesets/${id}/unarchive`),
```

- [ ] **Step 4: Add the tab**

In `web/src/routes/admin/adminRoutes.ts`, in `SETUP_TABS`, after `{ key: 'seasons', label: 'Seasons', path: '/admin/setup/seasons' },` add:

```ts
  { key: 'rulesets', label: 'Rulesets', path: '/admin/setup/rulesets' },
```

In `web/src/routes/Admin.tsx`, after `import { EventEditor } from './admin/events/EventEditor';` add:

```ts
import { AdminRulesets } from './admin/rulesets/AdminRulesets';
```

and after `{r.desk === 'setup' && r.section === 'seasons' && <AdminSeasons />}` add:

```tsx
        {r.desk === 'setup' && r.section === 'rulesets' && <AdminRulesets />}
```

- [ ] **Step 5: Write the draft reader, the form and the tab**

`web/src/routes/admin/rulesets/rulesDraft.ts`:

```ts
import type { EditableRules, MatchRules } from '../../../api';
import { readWhole } from '../events/wholeNumber';

/**
 * The Rulesets editor's number fields, kept as typed and read only at Save
 * (like the stage form): a blank pause limit or length means no limit and is
 * sent as null, never 0; a blank technical pauses or no-show grace is an
 * error the form shows without sending anything. The server
 * (src/rulesetStore.ts readEditableRules) judges every range.
 */
export interface RulesTyped { limit: string; seconds: string; techPauses: string; grace: string }

export function editableFrom(r: MatchRules): EditableRules {
  const { rated: _rated, penalties: _penalties, ...rest } = r;
  return rest;
}

export function typedFrom(r: EditableRules): RulesTyped {
  return {
    limit: r.pause.limit === null ? '' : String(r.pause.limit),
    seconds: r.pause.seconds === null ? '' : String(r.pause.seconds),
    techPauses: String(r.pause.techPauses),
    grace: String(r.noShowGraceMinutes),
  };
}

export function readRules(base: EditableRules, typed: RulesTyped): { ok: true; value: EditableRules } | { ok: false; error: string } {
  const limit = readWhole(typed.limit, 'Pauses per team', true);
  if (!limit.ok) return limit;
  const seconds = readWhole(typed.seconds, 'Pause length', true);
  if (!seconds.ok) return seconds;
  const tech = readWhole(typed.techPauses, 'Technical pauses', false);
  if (!tech.ok) return tech;
  const grace = readWhole(typed.grace, 'No-show grace', false);
  if (!grace.ok) return grace;
  return {
    ok: true,
    value: {
      ...base,
      pause: { ...base.pause, limit: limit.value, seconds: seconds.value, techPauses: tech.value as number },
      noShowGraceMinutes: grace.value as number,
    },
  };
}
```

`web/src/routes/admin/rulesets/RulesetForm.tsx`:

```tsx
import { useId, useState } from 'preact/hooks';
import type { AdminRuleset, EditableRules, MatchRules } from '../../../api';
import { FormGroup, FormRow, ToggleRow } from '../events/FormRow';
import { editableFrom, readRules, typedFrom, type RulesTyped } from './rulesDraft';

const BOSSES: [MatchRules['bosses'], string][] = [
  ['random_published', 'Random, shown in game'], ['fixed', 'Fixed'], ['voteboss', 'Voted by the teams'],
];
const SIDE_RULES: [MatchRules['sideRule'], string][] = [
  ['higher_seed_chooses', 'Higher seed picks sides'], ['non_picker_chooses', 'The team that did not pick the campaign picks sides'], ['coin', 'Coin toss'],
];
const val = (e: Event): string => (e.target as HTMLInputElement).value;

/** One ruleset's name and rules, laid out like the Settings desk. Rated and
 *  penalties are not here: only PUG has them, and PUG is read only. Saving
 *  hands the name and rules up; the desk sends them. */
export function RulesetForm({ ruleset, rules, busy, onSave, onCancel }: {
  ruleset: AdminRuleset; rules: MatchRules; busy: boolean; onSave: (name: string, rules: EditableRules) => void; onCancel: () => void;
}) {
  const [name, setName] = useState(ruleset.name);
  const [d, setD] = useState<EditableRules>(() => editableFrom(rules));
  const [typed, setTyped] = useState<RulesTyped>(() => typedFrom(editableFrom(rules)));
  const [problem, setProblem] = useState<string | null>(null);
  const uid = useId();
  const id = (k: string): string => `${uid}-${k}`;
  const set = (patch: Partial<EditableRules>) => setD((x) => ({ ...x, ...patch }));
  const type = (k: keyof RulesTyped) => (e: Event) => { const v = val(e); setTyped((x) => ({ ...x, [k]: v })); };
  const submit = (e: Event) => {
    e.preventDefault();
    const r = readRules(d, typed);
    if (!r.ok) { setProblem(r.error); return; }
    setProblem(null);
    onSave(name, r.value);
  };

  return (
    <form class="eventform eventform--stage" onSubmit={submit}>
      {problem && <p class="error" role="alert">{problem}</p>}
      <FormGroup title="Ruleset">
        <FormRow label="Name" help={ruleset.template ? 'A built-in ruleset keeps its name.' : '3 to 40 characters, not used by another ruleset.'} for={id('name')}>
          <input id={id('name')} aria-label="Ruleset name" value={name} maxLength={40} disabled={ruleset.template} onInput={(e) => setName(val(e))} />
        </FormRow>
      </FormGroup>
      <FormGroup title="Pauses">
        <FormRow label="Pauses per team" help="Blank for no limit. (0 to 10)" for={id('limit')}>
          <input id={id('limit')} aria-label="Pauses per team" type="number" min={0} max={10} value={typed.limit} onInput={type('limit')} />
        </FormRow>
        <FormRow label="Pause length" help="Seconds each. Blank for no limit. (30 to 600)" for={id('seconds')}>
          <input id={id('seconds')} aria-label="Pause length" type="number" min={30} max={600} value={typed.seconds} onInput={type('seconds')} />
        </FormRow>
        <ToggleRow label="Both teams unpause" help="Unpausing needs both teams to type !unpause." checked={d.pause.mutualUnpause}
          onChange={() => set({ pause: { ...d.pause, mutualUnpause: !d.pause.mutualUnpause } })} />
        <FormRow label="Technical pauses" help="A separate allowance per team. (0 to 5)" for={id('tech')}>
          <input id={id('tech')} aria-label="Technical pauses" type="number" min={0} max={5} value={typed.techPauses} onInput={type('techPauses')} />
        </FormRow>
      </FormGroup>
      <FormGroup title="Match">
        <ToggleRow label="Team lock" help="Rostered players stay on their side." checked={d.teamLock} onChange={() => set({ teamLock: !d.teamLock })} />
        <ToggleRow label="Players control the map" help="Players may use !nextmap and !stay and change the campaign." checked={d.playerMapControl}
          onChange={() => set({ playerMapControl: !d.playerMapControl })} />
        <ToggleRow label="Restart a half" help="Both teams may !restart the half they are playing." checked={d.restartHalf.allowed}
          onChange={() => set({ restartHalf: { allowed: !d.restartHalf.allowed, lockAfterDamage: false } })} />
        {d.restartHalf.allowed && (
          <ToggleRow label="Only before damage" help="No restart once a team has done damage." checked={d.restartHalf.lockAfterDamage}
            onChange={() => set({ restartHalf: { allowed: true, lockAfterDamage: !d.restartHalf.lockAfterDamage } })} />
        )}
        <FormRow label="No-show grace" help="Minutes a side has to arrive. (5 to 60)" for={id('grace')}>
          <input id={id('grace')} aria-label="No-show grace" type="number" min={5} max={60} value={typed.grace} onInput={type('grace')} />
        </FormRow>
        <FormRow label="Boss spawns" for={id('bosses')}>
          <select id={id('bosses')} aria-label="Boss spawns" value={d.bosses} onChange={(e) => set({ bosses: val(e) as MatchRules['bosses'] })}>
            {BOSSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </FormRow>
        <FormRow label="Side choice" for={id('side')}>
          <select id={id('side')} aria-label="Side choice" value={d.sideRule} onChange={(e) => set({ sideRule: val(e) as MatchRules['sideRule'] })}>
            {SIDE_RULES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </FormRow>
        <ToggleRow label="Side-locked spectating" help="Team spectators see only their own side." checked={d.spectate.sideLocked}
          onChange={() => set({ spectate: { sideLocked: !d.spectate.sideLocked } })} />
      </FormGroup>
      <div class="eventform__actions">
        <button class="btn" type="submit" disabled={busy}>Save ruleset</button>
        <button class="btn btn--ghost" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
```

`web/src/routes/admin/rulesets/AdminRulesets.tsx`:

```tsx
import { useId, useState } from 'preact/hooks';
import { adminApi, type AdminRuleset } from '../../../api';
import { useFetch } from '../../../hooks/useFetch';
import { Empty, Panel } from '../../../components/bits';
import { useAction } from '../useAction';
import { FormRow } from '../events/FormRow';
import { RulesetForm } from './RulesetForm';

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** "Not in use", or what still uses it: open bookings and unfinished events. */
export function inUseText(u: AdminRuleset['inUse']): string {
  if (u.bookings === 0 && u.events === 0) return 'Not in use';
  return `In use: ${[u.bookings > 0 ? plural(u.bookings, 'open booking') : '', u.events > 0 ? plural(u.events, 'event') : ''].filter(Boolean).join(', ')}`;
}

/** Setup > Rulesets (admins only): copy a ruleset, edit one, archive one.
 *  PUG is read only and the three built-ins cannot be archived; the server
 *  enforces both, the buttons only leave them out. */
export function AdminRulesets() {
  const { data, reload } = useFetch((s) => adminApi.rulesets(s), []);
  const { busy, error, run } = useAction(reload);
  const [editing, setEditing] = useState<number | null>(null);
  const [copyFrom, setCopyFrom] = useState<number | null>(null);
  const [name, setName] = useState('');
  const uid = useId();
  if (!data) return <Panel><p class="muted">Loading...</p></Panel>;
  const source = copyFrom ?? data.rulesets[0]?.id ?? null;

  const create = (e: Event) => {
    e.preventDefault();
    if (source === null) return;
    void run(async () => { await adminApi.createRuleset(source, name); setName(''); });
  };

  return (
    <div class="stack">
      {error && <p class="error" role="alert">{error}</p>}
      <Panel>
        <h3>New ruleset</h3>
        <p class="muted">A new ruleset starts as a copy of another. Copies are never rated and never give PUG penalties.</p>
        <form class="eventform" onSubmit={create}>
          <FormRow label="Copy from" for={`${uid}-from`}>
            <select id={`${uid}-from`} aria-label="Copy from" value={source === null ? '' : String(source)}
              onChange={(e) => setCopyFrom(Number((e.target as HTMLSelectElement).value))}>
              {data.rulesets.map((r) => <option key={r.id} value={String(r.id)}>{r.name}{r.archived ? ' (archived)' : ''}</option>)}
            </select>
          </FormRow>
          <FormRow label="Name" help="3 to 40 characters, not used by another ruleset." for={`${uid}-name`}>
            <input id={`${uid}-name`} aria-label="New ruleset name" value={name} maxLength={40} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
          </FormRow>
          <div class="eventform__actions">
            <button class="btn" type="submit" disabled={busy || name.trim().length < 3}>Create copy</button>
          </div>
        </form>
      </Panel>
      <Panel>
        <h3>Rulesets</h3>
        <p class="muted">Changes apply to new bookings and events; running and finished ones keep the rules they started with.</p>
        {data.rulesets.length === 0 ? <Empty>No rulesets.</Empty> : (
          <ul class="admin-list rulesetlist">
            {data.rulesets.map((r) => (
              <li key={r.id}>
                <strong>{r.name}</strong>{' '}
                <span class="teamchip">{r.template ? 'Built-in' : r.basedOn ? `Copy of ${r.basedOn}` : 'Custom'}</span>{' '}
                {r.readOnly && <><span class="teamchip">Read only</span>{' '}</>}
                {r.archived && <><span class="teamchip teamchip--cancelled">Archived</span>{' '}</>}
                <span class="muted">· {inUseText(r.inUse)}</span>
                {r.summary && <p class="muted">{r.summary}</p>}
                {r.readOnly && <p class="muted">Mirrors the live PUG config, so it is changed in the server cfg, not here.</p>}
                <div class="inlinerow">
                  {!r.readOnly && r.rules && editing !== r.id && (
                    <button class="btn btn--ghost btn--sm" type="button" disabled={busy} onClick={() => setEditing(r.id)}>Edit</button>
                  )}
                  {!r.template && (r.archived
                    ? <button class="btn btn--ghost btn--sm" type="button" disabled={busy} onClick={() => void run(() => adminApi.unarchiveRuleset(r.id))}>Unarchive</button>
                    : <button class="btn btn--ghost btn--sm" type="button" disabled={busy}
                        onClick={() => void run(() => adminApi.archiveRuleset(r.id), {
                          title: `Archive ${r.name}?`, body: 'It leaves every picker. Bookings and events that already use it keep their rules.', confirmLabel: 'Archive',
                        })}>Archive</button>)}
                </div>
                {editing === r.id && r.rules && (
                  <RulesetForm ruleset={r} rules={r.rules} busy={busy} onCancel={() => setEditing(null)}
                    onSave={(n, rules) => void run(async () => { await adminApi.updateRuleset(r.id, n, rules); setEditing(null); })} />
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
```

Append to `web/src/styles/app.css`:

```css
/* Setup > Rulesets and Game configs (rulesets editor plan): rows in the
   admin-list look, a summary line under the name, the row's buttons below. */
.rulesetlist li > p { margin: var(--sp-1) 0 0; }
.rulesetlist .inlinerow { margin-top: var(--sp-2); }
.rulesetlist .inlinerow:empty { display: none; }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run web/src/routes/admin/rulesets web/src/routes/admin/adminRoutes.test.ts && npx tsc --noEmit -p web/tsconfig.json`
Expected: PASS, no type errors.

Note: the number inputs carry `min`/`max`, so a browser (and happy-dom) refuses to submit an out-of-range number before `onSubmit` runs; that is why the refusal test uses a server refusal (a clashing name) rather than a grace of 90.

- [ ] **Step 7: Commit**

```bash
git add web/src/api.ts web/src/routes/admin/adminRoutes.ts web/src/routes/admin/adminRoutes.test.ts web/src/routes/Admin.tsx web/src/styles/app.css web/src/routes/admin/rulesets
git commit -m "Setup desk: a Rulesets tab to copy, edit and archive rulesets, PUG read only"
```

---

### Task 6: The Game configs tab

**Files:**
- Modify: `web/src/api.ts` (one type after `AdminRuleset`; calls after `unarchiveRuleset`)
- Modify: `web/src/routes/admin/adminRoutes.ts` (`SETUP_TABS`), `web/src/routes/admin/adminRoutes.test.ts`
- Modify: `web/src/routes/Admin.tsx`
- Modify: `web/src/styles/app.css` (append)
- Create: `web/src/routes/admin/rulesets/AdminGameConfigs.tsx`
- Test: `web/src/routes/admin/rulesets/AdminGameConfigs.test.tsx` (new)

**Interfaces:**
- Consumes: the Task 4 game config routes; `inUseText` and CSS class `rulesetlist` (Task 5); `FormRow`; `useAction`, `type Run`; `useFetch`; `enc` (module-private `encodeURIComponent` alias in `web/src/api.ts`).
- Produces: `interface AdminGameConfig` in `web/src/api.ts`; `adminApi.gameConfigs(signal?)`, `adminApi.createGameConfig({ key, label, cfg })`, `adminApi.updateGameConfig(key, { label, enabled })`, `adminApi.deleteGameConfig(key)`; the Setup tab `configs` at `/admin/setup/configs`; CSS class `admin-warn`.

- [ ] **Step 1: Write the failing tests**

`web/src/routes/admin/rulesets/AdminGameConfigs.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { AdminGameConfig } from '../../../api';

const { mockAdmin, mockConfirm } = vi.hoisted(() => ({
  mockAdmin: { gameConfigs: vi.fn(), createGameConfig: vi.fn(), updateGameConfig: vi.fn(), deleteGameConfig: vi.fn() },
  mockConfirm: vi.fn(),
}));
vi.mock('../../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api')>();
  return { ...actual, adminApi: { ...actual.adminApi, ...mockAdmin } };
});
vi.mock('../../../components/Confirm', () => ({ confirm: mockConfirm }));
const { AdminGameConfigs } = await import('./AdminGameConfigs');
const { ApiError } = await import('../../../api');

const ROWS: AdminGameConfig[] = [
  { key: 'standard', label: 'Standard (Rotoblin PUG 4v4)', cfg: 'pug_match', enabled: true, locked: true, inUse: { bookings: 3, events: 0 } },
  { key: 'zonemod', label: 'ZoneMod 4v4', cfg: 'zonemod_4v4', enabled: true, locked: false, inUse: { bookings: 0, events: 1 } },
  { key: 'spare', label: 'Spare config', cfg: 'spare', enabled: false, locked: false, inUse: { bookings: 0, events: 0 } },
];
const rowOf = (label: string) => screen.getByText(label, { selector: 'strong' }).closest('li') as HTMLElement;
const button = (el: HTMLElement, name: string) => Array.from(el.querySelectorAll('button')).find((b) => b.textContent === name) ?? null;

afterEach(() => cleanup());
beforeEach(() => {
  for (const f of [...Object.values(mockAdmin), mockConfirm]) f.mockReset();
  mockAdmin.gameConfigs.mockResolvedValue({ gameConfigs: ROWS });
  for (const f of [mockAdmin.createGameConfig, mockAdmin.updateGameConfig, mockAdmin.deleteGameConfig]) f.mockResolvedValue({ ok: true });
  mockConfirm.mockResolvedValue(true);
});

describe('AdminGameConfigs', () => {
  it('shows each config with the cfg it execs and what uses it; standard can only be relabelled', async () => {
    render(<AdminGameConfigs />);
    await screen.findByText('ZoneMod 4v4', { selector: 'strong' });
    expect(rowOf('Standard (Rotoblin PUG 4v4)').textContent).toContain('exec pug_match');
    expect(rowOf('Standard (Rotoblin PUG 4v4)').textContent).toContain('In use: 3 open bookings');
    expect(button(rowOf('Standard (Rotoblin PUG 4v4)'), 'Turn off')).toBeNull();
    expect(button(rowOf('Standard (Rotoblin PUG 4v4)'), 'Delete')).toBeNull();
    expect(button(rowOf('ZoneMod 4v4'), 'Delete')).toBeNull();
    expect(rowOf('Spare config').textContent).toContain('Off');
    expect(button(rowOf('Spare config'), 'Turn on')).toBeTruthy();
  });

  it('relabels, turns off and deletes (after asking)', async () => {
    render(<AdminGameConfigs />);
    await screen.findByText('ZoneMod 4v4', { selector: 'strong' });
    fireEvent.input(screen.getByLabelText('Label for zonemod'), { target: { value: 'ZoneMod' } });
    fireEvent.click(button(rowOf('ZoneMod 4v4'), 'Save label')!);
    await waitFor(() => expect(mockAdmin.updateGameConfig).toHaveBeenCalledWith('zonemod', { label: 'ZoneMod', enabled: true }));
    fireEvent.click(button(rowOf('ZoneMod 4v4'), 'Turn off')!);
    await waitFor(() => expect(mockAdmin.updateGameConfig).toHaveBeenCalledWith('zonemod', { label: 'ZoneMod 4v4', enabled: false }));
    fireEvent.click(button(rowOf('Spare config'), 'Delete')!);
    await waitFor(() => expect(mockAdmin.deleteGameConfig).toHaveBeenCalledWith('spare'));
    expect(mockConfirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Delete Spare config?', danger: true }));
  });

  it('adds a config, warning that the cfg must be on every pool server, and shows a refusal', async () => {
    mockAdmin.createGameConfig.mockRejectedValueOnce(new ApiError(400, 'A cfg name is lowercase letters, digits and underscores, without .cfg.'));
    render(<AdminGameConfigs />);
    await screen.findByText('ZoneMod 4v4', { selector: 'strong' });
    fireEvent.input(screen.getByLabelText('Key'), { target: { value: 'confogl' } });
    fireEvent.input(screen.getByLabelText('Label'), { target: { value: 'Confogl 4v4' } });
    fireEvent.input(screen.getByLabelText('Cfg'), { target: { value: 'confogl.cfg' } });
    expect(screen.getByText(/must already be on every pool server/).textContent).toContain('exec confogl.cfg');
    fireEvent.click(screen.getByRole('button', { name: 'Add config' }));
    expect(await screen.findByText('A cfg name is lowercase letters, digits and underscores, without .cfg.')).toBeTruthy();
    fireEvent.input(screen.getByLabelText('Cfg'), { target: { value: 'confogl' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add config' }));
    await waitFor(() => expect(mockAdmin.createGameConfig).toHaveBeenLastCalledWith({ key: 'confogl', label: 'Confogl 4v4', cfg: 'confogl' }));
  });
});
```

In `web/src/routes/admin/adminRoutes.test.ts`, inside `it('leaves room for the other two desks', ...)`, after the `/admin/setup/rulesets` line for `asAdmin`, add:

```ts
    expect(parseAdminPath('/admin/setup/configs', asAdmin)).toEqual({ desk: 'setup', section: 'configs', param: null });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run web/src/routes/admin/rulesets/AdminGameConfigs.test.tsx web/src/routes/admin/adminRoutes.test.ts`
Expected: FAIL: `Failed to resolve import "./AdminGameConfigs"`, and `/admin/setup/configs` parses as `section: 'unknown'`.

- [ ] **Step 3: Add the API type and calls**

In `web/src/api.ts`, right after the closing `}` of `export interface AdminRuleset`:

```ts
/** Mirrors src/gameConfigStore.ts GameConfigListItem. */
export interface AdminGameConfig {
  key: string; label: string; cfg: string; enabled: boolean; locked: boolean; inUse: { bookings: number; events: number };
}
```

In `adminApi`, right after the line ``unarchiveRuleset: (id: number) => post(`/api/admin/rulesets/${id}/unarchive`),``:

```ts
  gameConfigs: (signal?: AbortSignal) => get<{ gameConfigs: AdminGameConfig[] }>('/api/admin/game-configs', signal),
  createGameConfig: (body: { key: string; label: string; cfg: string }) => post<{ key: string }>('/api/admin/game-configs', body),
  updateGameConfig: (key: string, body: { label: string; enabled: boolean }) => post(`/api/admin/game-configs/${enc(key)}`, body),
  deleteGameConfig: (key: string) => post(`/api/admin/game-configs/${enc(key)}/delete`),
```

- [ ] **Step 4: Add the tab**

In `web/src/routes/admin/adminRoutes.ts`, in `SETUP_TABS`, after the `rulesets` entry add:

```ts
  { key: 'configs', label: 'Game configs', path: '/admin/setup/configs' },
```

In `web/src/routes/Admin.tsx`, after `import { AdminRulesets } from './admin/rulesets/AdminRulesets';` add:

```ts
import { AdminGameConfigs } from './admin/rulesets/AdminGameConfigs';
```

and after `{r.desk === 'setup' && r.section === 'rulesets' && <AdminRulesets />}` add:

```tsx
        {r.desk === 'setup' && r.section === 'configs' && <AdminGameConfigs />}
```

- [ ] **Step 5: Write the tab**

`web/src/routes/admin/rulesets/AdminGameConfigs.tsx`:

```tsx
import { useId, useState } from 'preact/hooks';
import { adminApi, type AdminGameConfig } from '../../../api';
import { useFetch } from '../../../hooks/useFetch';
import { Empty, Panel } from '../../../components/bits';
import { useAction, type Run } from '../useAction';
import { FormRow } from '../events/FormRow';
import { inUseText } from './AdminRulesets';

/** One config: its label (editable), the cfg setup execs, on or off, and
 *  Delete while nothing open uses it. 'standard' is never off or deleted. */
function ConfigRow({ c, busy, run }: { c: AdminGameConfig; busy: boolean; run: Run }) {
  const [label, setLabel] = useState(c.label);
  const unused = c.inUse.bookings === 0 && c.inUse.events === 0;
  return (
    <li>
      <strong>{c.label}</strong>{' '}
      <span class="teamchip">{c.key}</span>{' '}
      {c.locked && <><span class="teamchip">Default</span>{' '}</>}
      {!c.enabled && <><span class="teamchip teamchip--cancelled">Off</span>{' '}</>}
      <span class="muted">· exec {c.cfg} · {inUseText(c.inUse)}</span>
      <div class="inlinerow">
        <input aria-label={`Label for ${c.key}`} value={label} maxLength={60} onInput={(e) => setLabel((e.target as HTMLInputElement).value)} />
        <button class="btn btn--ghost btn--sm" type="button" disabled={busy || label.trim() === c.label}
          onClick={() => void run(() => adminApi.updateGameConfig(c.key, { label, enabled: c.enabled }))}>Save label</button>
        {!c.locked && (
          <button class="btn btn--ghost btn--sm" type="button" disabled={busy}
            onClick={() => void run(() => adminApi.updateGameConfig(c.key, { label: c.label, enabled: !c.enabled }))}>
            {c.enabled ? 'Turn off' : 'Turn on'}
          </button>
        )}
        {!c.locked && unused && (
          <button class="btn btn--ghost btn--sm" type="button" disabled={busy}
            onClick={() => void run(() => adminApi.deleteGameConfig(c.key), {
              title: `Delete ${c.label}?`, body: 'Finished bookings and events that used it keep showing its key.', confirmLabel: 'Delete', danger: true,
            })}>Delete</button>
        )}
      </div>
    </li>
  );
}

/** Setup > Game configs (admins only): the balance layers bookings and event
 *  stages may pick. Turning one off takes it out of the pickers only. */
export function AdminGameConfigs() {
  const { data, reload } = useFetch((s) => adminApi.gameConfigs(s), []);
  const { busy, error, run } = useAction(reload);
  const [key, setKey] = useState('');
  const [label, setLabel] = useState('');
  const [cfg, setCfg] = useState('');
  const uid = useId();
  if (!data) return <Panel><p class="muted">Loading...</p></Panel>;

  const create = (e: Event) => {
    e.preventDefault();
    void run(async () => {
      await adminApi.createGameConfig({ key: key.trim(), label, cfg: cfg.trim() });
      setKey(''); setLabel(''); setCfg('');
    });
  };

  return (
    <div class="stack">
      {error && <p class="error" role="alert">{error}</p>}
      <Panel>
        <h3>Game configs</h3>
        <p class="muted">What a booked or tournament server runs. Off takes a config out of the pickers; what already uses it keeps it.</p>
        {data.gameConfigs.length === 0 ? <Empty>No game configs.</Empty> : (
          <ul class="admin-list rulesetlist">
            {data.gameConfigs.map((c) => <ConfigRow key={`${c.key}:${c.label}`} c={c} busy={busy} run={run} />)}
          </ul>
        )}
      </Panel>
      <Panel>
        <h3>New game config</h3>
        <p class="admin-warn">The cfg file must already be on every pool server. Setup runs <code>exec {cfg.trim() || '<cfg>'}</code> on whichever box the booking gets.</p>
        <form class="eventform" onSubmit={create}>
          <FormRow label="Key" help="2 to 32 lowercase letters, digits or underscores. Fixed once made." for={`${uid}-key`}>
            <input id={`${uid}-key`} aria-label="Key" value={key} maxLength={32} onInput={(e) => setKey((e.target as HTMLInputElement).value)} />
          </FormRow>
          <FormRow label="Label" help="What the pickers show. 3 to 60 characters." for={`${uid}-label`}>
            <input id={`${uid}-label`} aria-label="Label" value={label} maxLength={60} onInput={(e) => setLabel((e.target as HTMLInputElement).value)} />
          </FormRow>
          <FormRow label="Cfg" help="The file name without .cfg: lowercase letters, digits and underscores." for={`${uid}-cfg`}>
            <input id={`${uid}-cfg`} aria-label="Cfg" value={cfg} maxLength={64} onInput={(e) => setCfg((e.target as HTMLInputElement).value)} />
          </FormRow>
          <div class="eventform__actions">
            <button class="btn" type="submit" disabled={busy || !key.trim() || !label.trim() || !cfg.trim()}>Add config</button>
          </div>
        </form>
      </Panel>
    </div>
  );
}
```

Append to `web/src/styles/app.css`:

```css
.admin-warn {
  margin: 0 0 var(--sp-3); padding: var(--sp-2) var(--sp-3); border-left: 3px solid var(--accent);
  background: var(--surface-2); color: var(--text-bright); font-size: var(--fs-dense);
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run web/src/routes/admin/rulesets web/src/routes/admin/adminRoutes.test.ts && npx tsc --noEmit -p web/tsconfig.json`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add web/src/api.ts web/src/routes/admin/adminRoutes.ts web/src/routes/admin/adminRoutes.test.ts web/src/routes/Admin.tsx web/src/styles/app.css web/src/routes/admin/rulesets/AdminGameConfigs.tsx web/src/routes/admin/rulesets/AdminGameConfigs.test.tsx
git commit -m "Setup desk: a Game configs tab to add, relabel, turn off and delete configs, with the cfg warning"
```

---

### Task 7: Picker help lines and summaries

**Files:**
- Modify: `src/rulesetStore.ts` (append `rulesetOptions`), `tests/rulesetStore.test.ts`
- Modify: `src/routes/bookings.ts` (`/api/bookings/options`), `src/routes/adminEvents.ts` (`AdminEventOptions`, `/api/admin/events/options`)
- Modify: `tests/bookingRoutes.test.ts`, `tests/adminEventRoutes.test.ts`
- Modify: `web/src/api.ts` (`RulesetOption`, `BookingOptions.rulesets`, `AdminEventOptions.rulesets`)
- Modify: `web/src/routes/admin/events/StageForm.tsx`, `web/src/routes/Bookings.tsx`, `web/src/styles/app.css` (append)
- Modify (fixtures gain `summary`): `web/src/routes/admin/events/EventEditor.test.tsx`, `web/src/routes/admin/events/stageDraft.test.ts`, `web/src/routes/Bookings.test.tsx`
- Test: `web/src/routes/admin/events/StageForm.test.tsx` (new), `web/src/routes/Bookings.test.tsx`

**Interfaces:**
- Consumes: `rulesSummary` (Task 1); `RulesetRow` and the private `rulesOf` in `src/rulesetStore.ts` (Task 2); `FormRow`'s `help` prop takes `ComponentChildren`.
- Produces: `rulesetOptions(db): { id: number; name: string; summary: string }[]` (live rulesets, id order); both options payloads send `rulesets: { id, name, summary }[]`; web `interface RulesetOption { id: number; name: string; summary: string }`.

- [ ] **Step 1: Write the failing tests**

In `tests/rulesetStore.test.ts`, change the store import to include `rulesetOptions`:

```ts
import {
  createRuleset, readEditableRules, rulesetList, rulesetOptions, setRulesetArchived, updateRuleset, type EditableRules,
} from '../src/rulesetStore.js';
```

and append:

```ts
describe('picker options', () => {
  it('offers the live rulesets in id order, each with its summary, and leaves archived ones out', () => {
    const { id } = okOf(createRuleset(db, { by: ADMIN, copyFrom: idOf('Casual Scrim'), name: 'Gone Soon' }));
    okOf(setRulesetArchived(db, { by: ADMIN, id, archived: true }));
    expect(rulesetOptions(db)).toEqual([
      { id: idOf('PUG'), name: 'PUG', summary: '3 pauses of 120 s · coin toss for sides · 10 min no-show grace' },
      { id: idOf('Standard Cup'), name: 'Standard Cup', summary: '3 pauses of 120 s · higher seed picks sides · 15 min no-show grace' },
      { id: idOf('Casual Scrim'), name: 'Casual Scrim', summary: 'Unlimited pauses · non-picker picks sides · 15 min no-show grace' },
    ]);
  });
});
```

In `tests/bookingRoutes.test.ts`, in `it('options list the pool with typical lengths and the limits', ...)`, after `expect(r.rulesets.map((x: { name: string }) => x.name)).toContain('Casual Scrim');` add:

```ts
    expect(r.rulesets.find((x: { name: string }) => x.name === 'Casual Scrim').summary)
      .toBe('Unlimited pauses · non-picker picks sides · 15 min no-show grace');
```

In `tests/adminEventRoutes.test.ts`, in `it('offers the poolable campaigns, ...')`, after `expect(o.defaultRulesetId).toBe(cup());` add:

```ts
    expect(o.rulesets[1]).toEqual({ id: cup(), name: 'Standard Cup', summary: '3 pauses of 120 s · higher seed picks sides · 15 min no-show grace' });
```

`web/src/routes/admin/events/StageForm.test.tsx`:

```tsx
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import type { AdminEventOptions, StageSettings } from '../../../api';
import { StageForm } from './StageForm';

const CUP = '3 pauses of 120 s · higher seed picks sides · 15 min no-show grace';
const SCRIM = 'Unlimited pauses · non-picker picks sides · 15 min no-show grace';
const OPTIONS: AdminEventOptions = {
  campaigns: [{ slug: 'no_mercy', name: 'No Mercy' }], defaultPool: ['no_mercy'],
  rulesets: [{ id: 2, name: 'Standard Cup', summary: CUP }, { id: 3, name: 'Casual Scrim', summary: SCRIM }], defaultRulesetId: 2,
  gameConfigs: [{ key: 'standard', label: 'Standard' }],
  defaults: {
    eligibility: { minPugs: 5, requireDiscord: true, srFloor: null, srCeiling: null },
    checkin: { enabled: true, opensMinutes: 60, closesMinutes: 15 },
    roster: { starters: 4, maxSubs: 2, lock: { kind: 'none' }, maxAdditions: null },
  },
};
const show = (initial: StageSettings | null = null) =>
  render(<StageForm options={OPTIONS} initial={initial} busy={false} onSave={() => {}} onCancel={() => {}} />);

afterEach(() => cleanup());

describe('StageForm pickers', () => {
  it('says what a ruleset and a game config are, and reads the chosen ruleset in one line', () => {
    show();
    expect(screen.getByText(/Match rules: pauses, side choice, no-show grace\./)).toBeTruthy();
    expect(screen.getByText('What the server runs (the cfg it loads).')).toBeTruthy();
    expect(screen.getByText(CUP)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Ruleset'), { target: { value: '3' } });
    expect(screen.getByText(SCRIM)).toBeTruthy();
    expect(screen.queryByText(CUP)).toBeNull();
  });

  it('a saved ruleset no longer offered has no summary line', () => {
    show({
      type: 'single_elim', config: { thirdPlace: false }, rulesetId: 9, gameConfig: 'standard', campaignPool: ['no_mercy'],
      vetoType: 'ban_to_one', chapters: null, scheduling: 'rolling', advanceCount: null,
    });
    expect(screen.queryByText(CUP)).toBeNull();
    expect(screen.queryByText(SCRIM)).toBeNull();
  });
});
```

In `web/src/routes/Bookings.test.tsx`, replace the `OPTIONS` line

```ts
  rulesets: [{ id: 3, name: 'Casual Scrim' }], gameConfigs: [{ key: 'standard', label: 'Standard' }],
```

with

```ts
  rulesets: [{ id: 3, name: 'Casual Scrim', summary: 'Unlimited pauses · non-picker picks sides · 15 min no-show grace' }],
  gameConfigs: [{ key: 'standard', label: 'Standard' }],
```

and add, before `it('the notification toggle posts the change', ...)`:

```tsx
  it('with more than one ruleset and config, says what each picker is, reads the chosen rules, and sends both', async () => {
    mockBookings.options.mockResolvedValue({
      ...OPTIONS,
      rulesets: [...OPTIONS.rulesets, { id: 2, name: 'Standard Cup', summary: '3 pauses of 120 s · higher seed picks sides · 15 min no-show grace' }],
      gameConfigs: [...OPTIONS.gameConfigs, { key: 'zonemod', label: 'ZoneMod 4v4' }],
    });
    mockBookings.create.mockResolvedValue({ id: 9 });
    const { LocationProvider } = await import('preact-iso');
    render(<LocationProvider><Bookings session={session} /></LocationProvider>);
    expect(await screen.findByText('Match rules: pauses, side choice, no-show grace.')).toBeTruthy();
    expect(screen.getByText('Unlimited pauses · non-picker picks sides · 15 min no-show grace')).toBeTruthy();
    expect(screen.getByText('What the server runs (the cfg it loads).')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Rules'), { target: { value: '2' } });
    expect(screen.getByText('3 pauses of 120 s · higher seed picks sides · 15 min no-show grace')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Game config'), { target: { value: 'zonemod' } });
    fireEvent.change(screen.getByLabelText('Opponent team'), { target: { value: '1' } });
    fireEvent.input(screen.getByLabelText('Start'), { target: { value: '2026-10-02T20:00' } });
    fireEvent.click(screen.getByLabelText('No Mercy'));
    fireEvent.click(screen.getByRole('button', { name: 'Book the server' }));
    await waitFor(() => expect(mockBookings.create).toHaveBeenCalled());
    expect(mockBookings.create.mock.calls[0][0]).toMatchObject({ rulesetId: 2, gameConfig: 'zonemod' });
    history.replaceState(null, '', '/');
  });

  it('with one ruleset and one config there is nothing to pick and no help line', async () => {
    render(<Bookings session={session} />);
    await screen.findByLabelText('No Mercy');
    expect(screen.queryByLabelText('Rules')).toBeNull();
    expect(screen.queryByLabelText('Game config')).toBeNull();
    expect(screen.queryByText('Match rules: pauses, side choice, no-show grace.')).toBeNull();
  });
```

In `web/src/routes/admin/events/EventEditor.test.tsx`, in `OPTIONS`, replace `rulesets: [{ id: 2, name: 'Standard Cup' }], defaultRulesetId: 2,` with:

```ts
rulesets: [{ id: 2, name: 'Standard Cup', summary: '3 pauses of 120 s · higher seed picks sides · 15 min no-show grace' }],
  defaultRulesetId: 2,
```

In `web/src/routes/admin/events/stageDraft.test.ts`, in `OPTIONS`, replace `rulesets: [{ id: 1, name: 'PUG' }, { id: 2, name: 'Standard Cup' }], defaultRulesetId: 2,` with:

```ts
rulesets: [
    { id: 1, name: 'PUG', summary: '3 pauses of 120 s · coin toss for sides · 10 min no-show grace' },
    { id: 2, name: 'Standard Cup', summary: '3 pauses of 120 s · higher seed picks sides · 15 min no-show grace' },
  ], defaultRulesetId: 2,
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/rulesetStore.test.ts tests/bookingRoutes.test.ts tests/adminEventRoutes.test.ts web/src/routes/admin/events web/src/routes/Bookings.test.tsx`
Expected: FAIL: `rulesetOptions is not a function`; the options summaries are `undefined`; the StageForm and Bookings tests cannot find `Match rules: pauses, side choice, no-show grace.` or the `Game config` select.

- [ ] **Step 3: Ship the summary in the options**

Append to `src/rulesetStore.ts`:

```ts
/** The live rulesets a picker offers, each with its one-line summary. */
export function rulesetOptions(db: DB): { id: number; name: string; summary: string }[] {
  const rows = db.prepare('SELECT * FROM rulesets WHERE archived_at IS NULL ORDER BY id').all() as RulesetRow[];
  return rows.map((r) => {
    const rules = rulesOf(r);
    return { id: r.id, name: r.name, summary: rules ? rulesSummary(rules) : '' };
  });
}
```

In `src/routes/bookings.ts`, add the import after `import { logAdmin } from '../admin/audit.js';`:

```ts
import { rulesetOptions } from '../rulesetStore.js';
```

and in `/api/bookings/options` replace

```ts
      rulesets: db.prepare('SELECT id, name FROM rulesets WHERE archived_at IS NULL ORDER BY id').all(),
```

with

```ts
      rulesets: rulesetOptions(db),
```

In `src/routes/adminEvents.ts`, add the import after `import { stageSummary } from '../events/format.js';`:

```ts
import { rulesetOptions } from '../rulesetStore.js';
```

in `interface AdminEventOptions` replace `rulesets: { id: number; name: string }[]; defaultRulesetId: number | null;` with

```ts
  rulesets: { id: number; name: string; summary: string }[]; defaultRulesetId: number | null;
```

and in `/api/admin/events/options` replace

```ts
    const rulesets = db.prepare('SELECT id, name FROM rulesets WHERE archived_at IS NULL ORDER BY id').all() as { id: number; name: string }[];
```

with

```ts
    const rulesets = rulesetOptions(db);
```

- [ ] **Step 4: The web types**

In `web/src/api.ts`, right before `/** Mirrors src/rulesets.ts MatchRules. */` (added in Task 5), add:

```ts
/** A ruleset a picker offers, with its one-line summary (src/events/format.ts rulesSummary). */
export interface RulesetOption { id: number; name: string; summary: string }
```

In `interface BookingOptions` replace `rulesets: { id: number; name: string }[];` with `rulesets: RulesetOption[];`, and in `interface AdminEventOptions` replace `rulesets: { id: number; name: string }[]; defaultRulesetId: number | null;` with `rulesets: RulesetOption[]; defaultRulesetId: number | null;`.

- [ ] **Step 5: The stage form**

In `web/src/routes/admin/events/StageForm.tsx`, right before `const toggle = (slug: string) =>` add:

```tsx
  // The chosen ruleset in one line; an archived one (no longer offered) has none.
  const summary = options.rulesets.find((r) => r.id === d.rulesetId)?.summary ?? '';
```

Replace `<FormRow label="Ruleset" for={id('ruleset')}>` with

```tsx
        <FormRow label="Ruleset" help={<>Match rules: pauses, side choice, no-show grace.{summary && <><br /><span>{summary}</span></>}</>} for={id('ruleset')}>
```

and `<FormRow label="Game config" for={id('config')}>` with

```tsx
        <FormRow label="Game config" help="What the server runs (the cfg it loads)." for={id('config')}>
```

- [ ] **Step 6: The booking form**

In `web/src/routes/Bookings.tsx`, in `BookForm`, after the `rulesetId` state line add:

```tsx
  const [gameConfig, setGameConfig] = useState<string>(options.gameConfigs.find((g) => g.key === 'standard')?.key ?? options.gameConfigs[0]?.key ?? 'standard');
  const summary = options.rulesets.find((r) => r.id === rulesetId)?.summary ?? '';
```

Replace `const { id } = await bookingsApi.create({ teamId, opponent, startsAt, playlist, rulesetId });` with

```tsx
      const { id } = await bookingsApi.create({ teamId, opponent, startsAt, playlist, rulesetId, gameConfig });
```

Replace the Rules block

```tsx
      {options.rulesets.length > 1 && (
        <label class="teamfield">Rules
          <select aria-label="Rules" value={rulesetId === undefined ? '' : String(rulesetId)} onChange={(e) => setRulesetId(Number((e.target as HTMLSelectElement).value))}>
            {options.rulesets.map((r) => <option key={r.id} value={String(r.id)}>{r.name}</option>)}
          </select>
        </label>
      )}
```

with

```tsx
      {options.rulesets.length > 1 && (
        <div class="bookform__pick">
          <label class="teamfield">Rules
            <select aria-label="Rules" value={rulesetId === undefined ? '' : String(rulesetId)} onChange={(e) => setRulesetId(Number((e.target as HTMLSelectElement).value))}>
              {options.rulesets.map((r) => <option key={r.id} value={String(r.id)}>{r.name}</option>)}
            </select>
          </label>
          <p class="muted">Match rules: pauses, side choice, no-show grace.</p>
          {summary && <p class="muted">{summary}</p>}
        </div>
      )}
      {options.gameConfigs.length > 1 && (
        <div class="bookform__pick">
          <label class="teamfield">Game config
            <select aria-label="Game config" value={gameConfig} onChange={(e) => setGameConfig((e.target as HTMLSelectElement).value)}>
              {options.gameConfigs.map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
            </select>
          </label>
          <p class="muted">What the server runs (the cfg it loads).</p>
        </div>
      )}
```

Append to `web/src/styles/app.css`:

```css
/* The booking form's Rules and Game config pickers, each with its help line. */
.bookform__pick { display: flex; flex-direction: column; gap: var(--sp-1); }
.bookform__pick p { margin: 0; font-size: var(--fs-dense); }
```

- [ ] **Step 7: Run the tests, the typecheck, the full suite and the build**

Run: `npx vitest run tests/rulesetStore.test.ts tests/bookingRoutes.test.ts tests/adminEventRoutes.test.ts web/src/routes/admin/events web/src/routes/Bookings.test.tsx`
Expected: PASS.

Run: `npm run typecheck && npm test && npm run build`
Expected: no type errors, every test file passes, the build finishes (the existing chunk-size warning is expected).

- [ ] **Step 8: Commit**

```bash
git add src/rulesetStore.ts src/routes/bookings.ts src/routes/adminEvents.ts tests/rulesetStore.test.ts tests/bookingRoutes.test.ts tests/adminEventRoutes.test.ts web/src/api.ts web/src/routes/admin/events/StageForm.tsx web/src/routes/admin/events/StageForm.test.tsx web/src/routes/admin/events/EventEditor.test.tsx web/src/routes/admin/events/stageDraft.test.ts web/src/routes/Bookings.tsx web/src/routes/Bookings.test.tsx web/src/styles/app.css
git commit -m "Pickers: the stage and booking forms say what a ruleset and a game config are, and read the chosen rules in one line"
```

---

## Self-review

- **Spec and decisions coverage.** Decision 1 (Rulesets tab: list, New as a copy, Edit every field but rated, Archive and Unarchive): Tasks 2, 4, 5. Decision 2 (PUG read only, non-PUG rated and penalties false, editor hides both): Task 2 (`isPug`, `unratedRules`), Task 5 (`editableFrom`, no fields). Decision 3 (snapshots untouched, the page line, archived leaves pickers, publish still refuses): Task 2 and Task 4 tests, the line in `AdminRulesets`. Decision 4 (game configs list, label, on/off, add with key and cfg rules and the warning, standard locked, delete only unused): Tasks 3, 4, 6. Decision 5 (one transaction with `logAdmin` before/after, names unique case-insensitively, 3 to 40, trimmed): Tasks 2 and 3. Decision 6 (picker help lines and summary in the payload): Tasks 1 and 7. Decision 7 (FormRow layout, phone safe, no em dashes): `FormRow`/`ToggleRow`/`eventform` everywhere, `.inlinerow` inputs shrink (`flex: 1 1 14rem; min-width: 0`), `.admin-setting` drops to one column under 640 px. Decision 8 (route tests and web tests): Tasks 4, 5, 6, 7.
- **Placeholder scan.** Every code step carries its code; no TBD, no "similar to".
- **Type consistency.** `RulesetListItem` (server) and `AdminRuleset` (web) have the same fields; `GameConfigListItem` and `AdminGameConfig` match; `EditableRules` is the same `Omit<MatchRules, 'rated' | 'penalties'>` on both sides; `rulesetOptions` returns `{ id, name, summary }`, the shape of the web `RulesetOption`; `inUseText` takes `{ bookings, events }`, which both list items carry.
- **Verified.** Every task's code was replayed onto a throwaway worktree of master `f58e9c60`: `npm run typecheck` clean, `npm test` 602 files and 9396 tests passing, `npm run build` exit 0.
