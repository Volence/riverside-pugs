# Tournaments plan T1a: events, stages and the event page

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admins create a tournament event on the site, give it a chain of stages (format, ruleset, campaign pool, veto, chapters, scheduling, advance count), a banner and a formatted description, publish it and open registration, or cancel it; mods read the same desk without being able to change anything; players the competitive switch lets in see `/events` (with banner thumbnails) and a read-only `/event/:slug` page with the banner, the status, a countdown to the start, the description, the format strip, the rules and campaign pool of each stage, the entry rules and an (empty for now) entries list.

**Architecture:** Five new tables (`events`, `event_stages`, `event_entries`, `event_entry_players`, `event_log`), the last being the audit trail. A pure module `src/events/validate.ts` owns every rule about an event's and a stage's settings and takes the lists it checks against (poolable campaigns, live rulesets, enabled game configs) as a `StageContext`, so it is tested without a database; `src/events/format.ts` turns settings and a ruleset into the lines people read. `src/events/events.ts` is the only writer of `events`, `event_stages` and `event_log`: each mutation is one better-sqlite3 transaction that re-reads, checks, writes and adds its `event_log` row, returning `{ ok, value } | { ok: false, error }` like `src/teams/teams.ts`. Two route files: `src/routes/adminEvents.ts` (staff read, admins write, not behind the switch, every write also `logAdmin`) and `src/routes/events.ts` (read only, behind `competitive_enabled` exactly as the team pages are). Banners reuse the team logo pipeline: a browser-side crop and resize, a server-side size and format check next to `checkLogo`, a new `banner` kind in `CommunityStore`, the community sweep keeping a file while an event holds it, and a serving route that answers only for keys an event the viewer may see holds. The description is rendered by a pure markdown-subset parser (`web/src/richText.ts`) and a Preact component that builds elements only, never HTML strings. The web gains an Events desk in the admin panel and two public pages.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Fastify 5, better-sqlite3, vitest (`npm test`, `npx vitest run <file>`), `npm run typecheck` (server and web), `npm run build`; Preact + preact-iso + @testing-library/preact (happy-dom) for the web.

**Spec:** `docs/superpowers/specs/2026-09-30-competitive-tournaments-design.md`, section 1 (Events and stages), section 2 (Entries and seeding: schema only here), section 7 (Event page `/event/:slug` with its banner, `/events`), Error handling (one transaction with an audit row), Testing, Rollout item 1 (first half). Scope and rulings: the controller's T1a decisions as amended by the owner on 2026-10-01, copied into "Rulings this plan makes" below.

## Plan T1 is split

Rollout item 1 ("Events, stages, entries data model; staff event editor; event page (read-only); registration and check-in") ships as two plans:

- **T1a (this plan):** the schema for events, stages, entries, entry players and the audit log; the pure validation module; event banners; the safe description formatter; the Events desk (admins: list, create, edit, banner, stages add/edit/reorder/remove, publish, open registration, cancel; mods: read only); the public `/events` list and `/event/:slug` page; the nav link; gating.
- **T1b (next plan, not this one):** team registration (entries, rosters, one entry per player per event, eligibility checks at registration), entry name and logo snapshots and a logo route that serves snapshot keys, the check-in window and drop-at-close, seeding by average SR and the staff seed reorder.

After T1a an admin can build and publish an event and open registration, but nobody can register yet. Do not open the switch to everyone for events before T1b.

## Global Constraints

- Tables: `events` (id, slug, name, banner_key, region, organizer_steamid, official, entry_kind `team` | `draft`, status, starts_at, description, eligibility_json, team_cap, checkin_json, roster_json, created_at, updated_at, finished_at, cancelled_at, cancel_reason), `event_stages` (id, event_id, ordinal, type, config_json, ruleset_id, rules_json snapshot, game_config, campaign_pool_json, veto_type, chapters, scheduling, advance_count, status), `event_entries`, `event_entry_players`, `event_log` (id, event_id, at, actor, action, detail; same shape as `booking_events`).
- Event status CHECK holds every value now: `draft`, `announced`, `registration`, `checkin`, `live`, `finished`, `cancelled`. Stage type CHECK: `single_elim`, `double_elim`, `round_robin`, `swiss`, `league`. Widening a CHECK needs a table rebuild, so nothing is left for later.
- T1a implements only `draft -> announced` (publish), `announced -> registration` (open registration) and any status except `finished` and `cancelled` `-> cancelled`.
- Every event state change and edit, the banner included, is one transaction with an `event_log` row. Admin routes also write `logAdmin`. Nothing outside `src/events/events.ts` writes `events`, `event_stages` or `event_log`.
- Public routes (`/api/events`, `/api/events/:slug`, `/api/events/banners/:key`) follow `competitive_enabled` exactly as the team pages do: a signed-in viewer goes through `competitiveAccess`, a signed-out one through `competitivePublic`; closed answers `404 { error: 'not found' }`.
- A `draft` event (and its banner) is visible only to staff, admins and mods; to anyone else it is the same 404 as a slug that does not exist, and the list leaves it out.
- The Events desk (`/api/admin/events*`) is not behind the switch. Every GET takes staff (`makeRequireMod`: admin or mod); every POST takes an admin (`makeRequireAdmin`), so a mod's write is a 403. The web desk shows a mod the list, the event, its banner, stages and history with no control at all.
- Description: at most 4000 characters, rendered by the safe formatter only: `#`, `##`, `###` headings, paragraphs, line breaks, `**bold**`, `*italic*`, unordered and ordered lists, `[text](url)` links and bare URLs for `http://` and `https://` only (anything else is plain text), links open with `target="_blank" rel="noopener noreferrer"`. Preact elements only: no HTML strings, no `dangerouslySetInnerHTML`.
- Banner: 1600 x 400, PNG or WebP as stored (the browser crops PNG, JPEG or WebP input to 4:1, scales it and re-encodes it as WebP, or PNG where it cannot write WebP), at most 1 MB, content addressed in the community store's `banners` folder, served only while an event the viewer may see holds the key.
- Slugs from the name like team slugs, unique over every event ever made (pages are permanent), never a reserved word (`new`, `edit`, `mine`, `admin`, `logos`, `banners`, `options`). Fixed at creation.
- All times are ISO-8601 UTC strings written by the app; the web shows them in the viewer's time zone and converts `datetime-local` input from it.
- Eligibility defaults: at least 5 completed PUGs, Discord linked, no SR floor or ceiling. Check-in defaults: on, opens 60 minutes before the start, closes 15 before. Roster defaults: 4 starters, at most 2 subs, no lock, no addition limit.
- Stage ruleset: a non-archived `rulesets` row chosen by id; the snapshot is `JSON.stringify(rulesForKind('tournament', parseRules(rules_json)))`. Game config: an enabled `game_configs` key, default `standard`. Campaign pool: 1 to 12 different campaigns from `poolableCampaigns`, default the site `map_pool` (`getCampaignPool`).
- Stage edits are refused once the event is `live`, `finished` or `cancelled`.
- Never write em dashes in code, comments, copy, commits or docs.
- Commit messages follow the repo style (plain sentence). Do not push. Do not deploy, restart, stage or rcon any live box.
- Several Claude sessions use `/home/volence/l4d/pug`: work in a worktree branch; check `git reflog -10` and `git status` before any write on master.

## Rulings this plan makes (for the owner to confirm)

From the T1a scope decisions, as amended by the owner on 2026-10-01 (1, 2, 4 and 14 changed; 21 and 22 are new):

1. **The description is formatted by a small safe formatter** (owner, 2026-10-01): a pure parser (`web/src/richText.ts`) turns a markdown subset into a tree, and `RichText` (`web/src/components/RichText.tsx`) turns the tree into Preact elements, never HTML strings and never `dangerouslySetInnerHTML`. Subset: `#`, `##`, `###` headings, paragraphs, line breaks, `**bold**`, `*italic*`, unordered and ordered lists, `[text](url)` for `http://` and `https://` only (anything else, `javascript:` included, renders as the plain text it is) and bare `http(s)` URLs auto-linked; links open with `target="_blank" rel="noopener noreferrer"`. The editor has a Preview toggle that uses the same component. At most 4000 characters. The event carries no other free rules text in T1a (the rules lines are generated from the ruleset), so the description is the one place it applies.
2. **Admins run the Events desk; mods read it** (owner, 2026-10-01). Mods get the desk tab, the event list, each event's details, banner, stages and history, with no create, edit, banner, publish, open-registration or cancel control; every write route still answers a mod with 403.
3. **Every status and stage type is in the CHECK constraints now** (`draft`, `announced`, `registration`, `checkin`, `live`, `finished`, `cancelled`; `single_elim`, `double_elim`, `round_robin`, `swiss`, `league`). T1a implements only publish, open registration and cancel (cancel never from `finished`).
4. **Banner upload is in this plan** (owner, 2026-10-01), on the team logo pipeline: browser-side crop and resize (`web/src/eventBanner.ts`, like `web/src/teamLogo.ts`), a server check next to `checkLogo` (`checkBanner`), the `CommunityStore`, an admin upload and remove route (with `event_log` and `logAdmin`), a serving route for keys an event holds, and the banner on the event page header and as a thumbnail in the `/events` list. Shape in Ruling 21.
5. **`entry_kind = 'draft'`** is accepted in the schema and the editor, but its signups belong to the drafts spec; the event page says "Draft event: individual signups open later."
6. **Stage editing locks once the event is live** (`live`, `finished`, `cancelled` refuse stage edits).
7. **A stage's ruleset is picked by id from non-archived rulesets.** The snapshot (`rulesForKind('tournament', parseRules(...))`) is taken at publish and again on every stage edit after publish, and is frozen when the stage starts (later plan). Game config from enabled `game_configs`, default `standard`.
8. **Campaign pool per stage** defaults to the site `map_pool`, editable to any subset of poolable campaigns, at least 1 and at most 12.
9. **Event slug from the name like team slugs**, reserved words include `new` and `edit`, unique among all events (no reuse, archived pages are permanent).
10. **Every state change and edit is one transaction with an `event_log` row**; admin edits also `logAdmin`.
11. **All times are stored as ISO UTC strings** written by the app and shown in the viewer's time zone.
12. **No em dashes** anywhere.

Decided by this plan where the scope left it open:

13. **The desk is not behind `competitive_enabled`** (same as the bookings admin list), so admins can prepare events while the switch is off. The public pages do follow the switch, so staff previewing `/event/:slug` need the switch to let them in (`admins` lets in admins only; `everyone` lets in mods too).
14. **Drafts are staff only on the public routes** (owner, 2026-10-01): admins and mods see draft events, and draft banners, on `/events` and `/event/:slug`; everyone else gets the 404.
15. **A draft-kind event cannot open registration in T1a**: `openRegistration` refuses it (`draft_signups_later`), since there is nothing to register for until the drafts spec.
16. **The stage chain is checked at publish and at open registration, not on every edit**, so an admin can build stages in any order. Chain rule: every stage but the last has an advance count, each smaller than the one before and smaller than the team cap; the last has none; a roster lock `after_round` must point at an existing stage.
17. **Per-stage limits:** `pick_ban` needs exactly 7 campaigns (ban, ban, pick, pick, ban, ban, decider), `home_away` at least 2, `ban_to_one` at least 1; a league stage is always `window` scheduled; `chapters` is null (standard) or 1 to 5; at most 5 stages per event; advance count 2 to 128. Stage config ranges: Swiss 1 to 9 rounds (default 4), round robin 1 to 8 groups, league 1 to 12 weeks and 1 to 3 matches a week.
18. **Removing a stage deletes its row** (nothing references stages yet) and renumbers the rest; the removal is in `event_log`.
19. **An account merge** moves the organizer, the `event_log` actor, `event_entries.registered_by` and entry roster places to the surviving account, closing the alt's place where both are on one entry (as `team_members` does).
20. **Publish re-checks every stage against the lists of that moment**: a ruleset archived, a game config turned off or a campaign no longer poolable since the stage was saved refuses the publish with that stage rule's own message.
21. **Banner shape:** exactly 1600 x 400 (4:1), stored as WebP or PNG (whatever the browser wrote; the server reads the type from the bytes and serves it as that), at most 1 MB, content addressed (sha256) in a new `banners` folder of the community store. A banner may be set or removed in any status, finished and cancelled included (the archive page keeps it). The community sweep keeps a banner file while any event, of any status, holds it, and (for T1b) keeps a team logo file while an `event_entries.logo_key` snapshot holds it.
22. **Formatter details:** `#` renders as an `h3`, `##` as an `h4`, `###` as an `h5`, because the description sits inside a panel whose own heading is an `h3`; lists are flat (no nesting) and an ordered list always counts from 1; `**` and `*` nest at most 4 deep, deeper markers stay as text; text past 4000 characters is not parsed.

## Not in this plan (and why)

- Registration, rosters, eligibility checks against players, check-in, seeding, entry logos: T1b.
- Prizes, donors, Discord posts, trophies: presentation plan (rollout 5).
- Brackets, Swiss and league pairing, standings, live updates over the websocket: rollout 2 and 3.
- The schedule section and live match strip on the event page: they need matches (rollout 3 and 4).
- Event support tools for mods (put a match on hold, extend a grace period, force a result, answer `!admin` calls) come with the match flow plan (rollout 3), and that plan must include mods, not admins only.

## Review Focus

- **Hostile or odd description text.** A `[x](javascript:...)` link, a raw `<script>` or `<img onerror>` tag, markers nested forty deep or 4000 characters of `[` must render as visible text, never as markup or a live link, and must not stall the page. Task 8 tests.
- **A datetime typed in the viewer's own zone comes back as the same instant.** An admin in UTC-5 types 20:00 and the page shows 20:00 to them and the matching hour to a viewer elsewhere; reloading the editor shows 20:00 again, not a shifted time. Task 7 tests the round trip in whatever zone the test runs in.
- **A banner that is not what it claims, or that outlives its event's visibility.** A JPEG, a wrong-size PNG or a 2 MB body is refused with its reason; a draft's banner is a 404 to a player even with the key; a removed banner stops being served; the sweep never deletes a banner an event (even a cancelled one) still holds. Task 6 tests.
- **Reordering, then removing, stages whose row order no longer matches their ordinal.** The unique `(event_id, ordinal)` index must never trip mid-renumber. Task 3 test.
- **Someone probing for a draft by slug, and a mod pressing a write route by hand.** A signed-out visitor and a player get a 404 body identical to an unknown slug's; a mod who calls any write route directly gets 403 and nothing changes. Tasks 4, 5 and 11 tests.

---

## File map

| File | Responsibility |
|---|---|
| `src/db.ts` | SCHEMA: `events`, `event_stages`, `event_entries`, `event_entry_players`, `event_log` with their indexes. |
| `src/mergePlayers.ts` | Event columns follow a merged account. |
| `src/events/validate.ts` | Pure: statuses, kinds, limits, error table, every settings parser, the stage chain, the allowed transitions, the slug base. |
| `src/events/format.ts` | Pure: stage summary line, veto and chapters labels, the readable lines of a ruleset. |
| `src/events/events.ts` | Every write to `events`, `event_stages`, `event_log` (the banner key included); the reads the routes share. |
| `src/events/views.ts` | Public list items and the event page view. |
| `src/community/validate.ts`, `src/community/store.ts`, `src/community/sweep.ts` | Banner check (`webpSize`, `checkBanner`, `bannerType`), the `banner` file kind, the sweep's banner and entry-logo references. |
| `src/routes/adminEvents.ts` | Desk HTTP surface: staff reads, admin writes, banner upload and remove. |
| `src/routes/events.ts` | Public read routes and the banner file route. |
| `src/server.ts` | Registers both route files. |
| `web/src/api.ts` | Event types, `eventsApi`, `bannerUrl`, desk calls on `adminApi`. |
| `web/src/eventFormat.ts` | Status labels, countdown text, time display and `datetime-local` conversion. |
| `web/src/eventBanner.ts` | Browser-side crop, resize and encode of a banner. |
| `web/src/richText.ts`, `web/src/components/RichText.tsx` | The safe markdown subset: parser and Preact renderer. |
| `web/src/routes/admin/adminRoutes.ts`, `web/src/routes/Admin.tsx` | The Events desk in the panel, for admins and (read only) mods. |
| `web/src/routes/admin/events/EventsDesk.tsx` | Event list and the create form. |
| `web/src/routes/admin/events/EventEditor.tsx`, `EventFieldsForm.tsx`, `StageForm.tsx`, `stageDraft.ts` | One event: lifecycle buttons, fields with Preview, banner, stages, history; read only for mods. |
| `web/src/routes/Events.tsx`, `web/src/routes/Event.tsx` | Public list and event page. |
| `web/src/AppRoutes.tsx`, `web/src/components/Nav.tsx`, `web/src/styles/app.css` | Routes, the nav link, styles. |
| `tests/eventFixture.ts` | Shared test fixture (not a test file). |

---
### Task 1: Schema and account merge

**Files:**
- Modify: `src/db.ts` (SCHEMA string, right after the line `CREATE INDEX IF NOT EXISTS scrim_blocks_target_steamid ON scrim_blocks (target_steamid);` and before `CREATE TABLE IF NOT EXISTS match_players`)
- Modify: `src/mergePlayers.ts` (`PLAIN` list after the `scrim_blocks` entry; the team close-out block before the `for (const [table, column] of PLAIN)` loop)
- Modify: `tests/db.test.ts` (the table list in `creates all tables`)
- Modify: `tests/mergePlayers.test.ts` (one case)
- Test: `tests/eventsSchema.test.ts` (new)

**Interfaces:**
- Consumes: nothing new.
- Produces: the five tables exactly as in Step 3. Later tasks rely on these column names: `events.slug, name, organizer_steamid, official (0/1), entry_kind, status, starts_at, description, eligibility_json, team_cap, checkin_json, roster_json, created_at, updated_at, finished_at, cancelled_at, cancel_reason`; `event_stages.event_id, ordinal, type, config_json, ruleset_id, rules_json, game_config, campaign_pool_json, veto_type, chapters, scheduling, advance_count, status, created_at, updated_at`; `event_entries.event_id, team_id, name, tag, logo_key, seed, status, placement, registered_by, created_at`; `event_entry_players.entry_id, steamid, role, added_at, removed_at`; `event_log.event_id, at, actor, action, detail`.

- [ ] **Step 1: Write the failing tests**

`tests/eventsSchema.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer } from '../src/players.js';

const A = '76561199000000701';
let db: DB;
let cup: number;
beforeEach(() => {
  db = openDb(':memory:');
  upsertPlayer(db, { steamid: A, name: 'boss', avatar: null }, []);
  cup = (db.prepare("SELECT id FROM rulesets WHERE name = 'Standard Cup'").get() as { id: number }).id;
});

const event = (over: Record<string, unknown> = {}) => {
  const row = {
    slug: 'cup', name: 'Cup', organizer_steamid: A, entry_kind: 'team', starts_at: '2026-10-10T20:00:00.000Z',
    eligibility_json: '{}', checkin_json: '{}', roster_json: '{}', created_at: 'x', updated_at: 'x', ...over,
  };
  const cols = Object.keys(row);
  return Number(db.prepare(`INSERT INTO events (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...Object.values(row)).lastInsertRowid);
};
const stage = (eventId: number, ordinal: number, type = 'swiss') => db.prepare(
  `INSERT INTO event_stages (event_id, ordinal, type, config_json, ruleset_id, campaign_pool_json, veto_type, scheduling, created_at, updated_at)
   VALUES (?, ?, ?, '{}', ?, '[]', 'ban_to_one', 'rolling', 'x', 'x')`,
).run(eventId, ordinal, type, cup);

describe('event schema', () => {
  it('an event starts as an official draft in region na and refuses an unknown status or entry kind', () => {
    const id = event();
    expect(db.prepare('SELECT status, official, region, description, banner_key FROM events WHERE id = ?').get(id))
      .toEqual({ status: 'draft', official: 1, region: 'na', description: '', banner_key: null });
    expect(() => db.prepare("UPDATE events SET status = 'paused' WHERE id = ?").run(id)).toThrow(/CHECK/);
    expect(() => event({ slug: 'other', entry_kind: 'solo' })).toThrow(/CHECK/);
  });

  it('holds every status and stage type the later plans need, so no CHECK has to widen', () => {
    const id = event();
    for (const s of ['announced', 'registration', 'checkin', 'live', 'finished', 'cancelled']) {
      db.prepare('UPDATE events SET status = ? WHERE id = ?').run(s, id);
    }
    ['single_elim', 'double_elim', 'round_robin', 'swiss', 'league'].forEach((t, i) => stage(id, i + 1, t));
    expect(() => stage(id, 9, 'ladder')).toThrow(/CHECK/);
  });

  it('slugs are unique over every event, and one ordinal per stage per event', () => {
    const id = event();
    expect(() => event()).toThrow(/UNIQUE/);
    stage(id, 1);
    expect(() => stage(id, 1)).toThrow(/UNIQUE/);
    stage(event({ slug: 'cup-2' }), 1);
  });

  it('one live place per player per entry, and a removed place can be taken again', () => {
    const id = event();
    const entry = Number(db.prepare("INSERT INTO event_entries (event_id, name, registered_by, created_at) VALUES (?, 'Rats', ?, 'x')")
      .run(id, A).lastInsertRowid);
    expect(db.prepare('SELECT status, tag, seed FROM event_entries WHERE id = ?').get(entry)).toEqual({ status: 'registered', tag: '', seed: null });
    const add = db.prepare("INSERT INTO event_entry_players (entry_id, steamid, role, added_at) VALUES (?, ?, 'starter', 'x')");
    add.run(entry, A);
    expect(() => add.run(entry, A)).toThrow(/UNIQUE/);
    db.prepare("UPDATE event_entry_players SET removed_at = 'y' WHERE entry_id = ?").run(entry);
    add.run(entry, A);
  });

  it('event_log rows carry an action and default their detail to {}', () => {
    const id = event();
    db.prepare("INSERT INTO event_log (event_id, at, actor, action) VALUES (?, 'x', NULL, 'created')").run(id);
    expect(db.prepare('SELECT actor, action, detail FROM event_log WHERE event_id = ?').get(id))
      .toEqual({ actor: null, action: 'created', detail: '{}' });
  });
});
```

Add to `tests/mergePlayers.test.ts`, inside `describe('mergePlayers', ...)`, after the case `'moves team rows, closing the alt membership where both are on one team, and keeps the captaincy'`:

```ts
  it('moves event rows, closing the alt place where both accounts are on one entry', () => {
    const ev = Number(db.prepare(
      `INSERT INTO events (slug, name, organizer_steamid, entry_kind, starts_at, eligibility_json, checkin_json, roster_json, created_at, updated_at)
       VALUES ('cup', 'Cup', ?, 'team', '2026-10-10T20:00:00.000Z', '{}', '{}', '{}', 'x', 'x')`,
    ).run(ALT).lastInsertRowid);
    db.prepare("INSERT INTO event_log (event_id, at, actor, action) VALUES (?, 'x', ?, 'created')").run(ev, ALT);
    const entry = Number(db.prepare("INSERT INTO event_entries (event_id, name, tag, registered_by, created_at) VALUES (?, 'Rats', 'RR', ?, 'x')")
      .run(ev, ALT).lastInsertRowid);
    const add = db.prepare("INSERT INTO event_entry_players (entry_id, steamid, role, added_at) VALUES (?, ?, ?, 'x')");
    add.run(entry, ALT, 'starter');
    add.run(entry, MAIN, 'sub');

    mergePlayers(db, { from: ALT, into: MAIN });

    expect(db.prepare('SELECT organizer_steamid FROM events WHERE id = ?').get(ev)).toEqual({ organizer_steamid: MAIN });
    expect(db.prepare('SELECT actor FROM event_log WHERE event_id = ?').get(ev)).toEqual({ actor: MAIN });
    expect(db.prepare('SELECT registered_by FROM event_entries WHERE id = ?').get(entry)).toEqual({ registered_by: MAIN });
    expect(db.prepare('SELECT steamid, role FROM event_entry_players WHERE entry_id = ? AND removed_at IS NULL').all(entry))
      .toEqual([{ steamid: MAIN, role: 'sub' }]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM event_entry_players WHERE steamid = ?').get(ALT)).toEqual({ n: 0 });
  });
```

In `tests/db.test.ts`, in the `creates all tables` list, replace the line

```ts
      'endorsements', 'fleet_files', 'fleet_readings',
```

with

```ts
      'endorsements', 'event_entries', 'event_entry_players', 'event_log', 'event_stages', 'events', 'fleet_files', 'fleet_readings',
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/eventsSchema.test.ts tests/db.test.ts tests/mergePlayers.test.ts`
Expected: FAIL with `no such table: events` (schema test and merge case) and a table list mismatch in `db.test.ts`.

- [ ] **Step 3: Add the tables**

In `src/db.ts`, inside the `SCHEMA` string, right after `CREATE INDEX IF NOT EXISTS scrim_blocks_target_steamid ON scrim_blocks (target_steamid);`:

```sql
-- Tournaments (spec part 2 sections 1 and 2; plan T1a). An event is a chain
-- of stages. status walks draft -> announced -> registration -> checkin ->
-- live -> finished, or stops at cancelled; every value the later plans need
-- is in the CHECK now, because widening one means rebuilding the table. Only
-- src/events/events.ts writes events, event_stages and event_log, each write
-- one transaction together with its event_log row (tests/eventLogGuard.test.ts).
-- eligibility_json, checkin_json and roster_json hold the shapes in
-- src/events/validate.ts. banner_key is the banner's community store key
-- (sha256), set by src/events/events.ts setEventBanner.
CREATE TABLE IF NOT EXISTS events (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  slug              TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  banner_key        TEXT,
  region            TEXT NOT NULL DEFAULT 'na',
  organizer_steamid TEXT NOT NULL REFERENCES players(steamid),
  official          INTEGER NOT NULL DEFAULT 1 CHECK (official IN (0,1)),
  entry_kind        TEXT NOT NULL CHECK (entry_kind IN ('team','draft')),
  status            TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','announced','registration','checkin','live','finished','cancelled')),
  starts_at         TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  eligibility_json  TEXT NOT NULL,
  team_cap          INTEGER,
  checkin_json      TEXT NOT NULL,
  roster_json       TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  finished_at       TEXT,
  cancelled_at      TEXT,
  cancel_reason     TEXT
);
CREATE INDEX IF NOT EXISTS events_starts ON events (starts_at);
-- rules_json is the ruleset snapshot: null while the event is a draft, taken
-- at publish and on every stage edit after it, frozen once the stage starts
-- (a later plan). chapters null means standard (every chapter but the
-- finale). Reordering goes through negative ordinals inside one transaction,
-- so the unique index never sees two stages on one number.
CREATE TABLE IF NOT EXISTS event_stages (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id           INTEGER NOT NULL REFERENCES events(id),
  ordinal            INTEGER NOT NULL,
  type               TEXT NOT NULL CHECK (type IN ('single_elim','double_elim','round_robin','swiss','league')),
  config_json        TEXT NOT NULL,
  ruleset_id         INTEGER NOT NULL REFERENCES rulesets(id),
  rules_json         TEXT,
  game_config        TEXT NOT NULL DEFAULT 'standard',
  campaign_pool_json TEXT NOT NULL,
  veto_type          TEXT NOT NULL CHECK (veto_type IN ('ban_to_one','home_away','pick_ban')),
  chapters           INTEGER,
  scheduling         TEXT NOT NULL CHECK (scheduling IN ('rolling','window')),
  advance_count      INTEGER,
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','live','finished')),
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS event_stages_ordinal ON event_stages (event_id, ordinal);
-- Entries and their rosters (spec part 2 section 2). Made here so the schema
-- lands in one piece; tournaments plan T1b writes them. name, tag and
-- logo_key are snapshots taken at registration, so a later rename or disband
-- never rewrites an archived event. A place on a roster is closed with
-- removed_at, never deleted.
CREATE TABLE IF NOT EXISTS event_entries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id      INTEGER NOT NULL REFERENCES events(id),
  team_id       INTEGER REFERENCES teams(id),
  name          TEXT NOT NULL,
  tag           TEXT NOT NULL DEFAULT '',
  logo_key      TEXT,
  seed          INTEGER,
  status        TEXT NOT NULL DEFAULT 'registered'
                CHECK (status IN ('registered','checked_in','dropped','disqualified','eliminated','placed')),
  placement     INTEGER,
  registered_by TEXT NOT NULL REFERENCES players(steamid),
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS event_entries_event ON event_entries (event_id);
CREATE TABLE IF NOT EXISTS event_entry_players (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id   INTEGER NOT NULL REFERENCES event_entries(id),
  steamid    TEXT NOT NULL REFERENCES players(steamid),
  role       TEXT NOT NULL CHECK (role IN ('starter','sub','coach')),
  added_at   TEXT NOT NULL,
  removed_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS event_entry_players_active ON event_entry_players (entry_id, steamid) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS event_entry_players_player ON event_entry_players (steamid) WHERE removed_at IS NULL;
-- The audit trail, shaped like booking_events: one row per state change or
-- edit, written in the same transaction. actor is null for the engine's own
-- changes (later plans).
CREATE TABLE IF NOT EXISTS event_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id),
  at       TEXT NOT NULL,
  actor    TEXT,
  action   TEXT NOT NULL,
  detail   TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS event_log_event ON event_log (event_id, id);
```

- [ ] **Step 4: Teach the merge**

In `src/mergePlayers.ts`, in `PLAIN`, after `['scrim_blocks', 'created_by'],`:

```ts
  // Events (src/events/events.ts) follow the person: the organizer and the
  // audit actor, like a booking's creator and booking_events.actor.
  ['events', 'organizer_steamid'],
  ['event_log', 'actor'],
  // Entries (tournaments plan T1b writes them): who registered one, and a
  // place on an entry's roster. Where both accounts hold a live place on one
  // entry, the alt's is closed first (below), as for team_members.
  ['event_entries', 'registered_by'],
  ['event_entry_players', 'steamid'],
```

In the transaction, right after the two `UPDATE team_members ...` / `UPDATE team_invites ...` statements that come before the `for (const [table, column] of PLAIN)` loop:

```ts
    db.prepare(`UPDATE event_entry_players SET removed_at = ? WHERE steamid = ? AND removed_at IS NULL
      AND entry_id IN (SELECT entry_id FROM event_entry_players WHERE steamid = ? AND removed_at IS NULL)`).run(teamsNow, from, into);
```

`MERGE_HANDLED_PLAYER_COLUMNS` spreads `PLAIN`, so the existing foreign-key enumeration test in `tests/mergePlayers.test.ts` now sees `events.organizer_steamid`, `event_entries.registered_by` and `event_entry_players.steamid` covered.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/eventsSchema.test.ts tests/db.test.ts tests/mergePlayers.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db.ts src/mergePlayers.ts tests/eventsSchema.test.ts tests/db.test.ts tests/mergePlayers.test.ts
git commit -m "Events: schema for events, stages, entries and the event_log audit trail; merges move them"
```

---

### Task 2: Pure validation and format modules

**Files:**
- Create: `src/events/validate.ts`
- Create: `src/events/format.ts`
- Test: `tests/eventsValidate.test.ts`, `tests/eventFormat.test.ts`

**Interfaces:**
- Consumes: `findSlurs(text: string): SlurKind[]` (`src/slurs.ts`), `hasUnsafeChars(s: string, allowNewlines?: boolean): boolean` (`src/profileFields.ts`), `MatchRules` (`src/rulesets.ts`).
- Produces (`src/events/validate.ts`):
  - `EVENT_STATUSES`, `type EventStatus`, `ENTRY_KINDS`, `type EntryKind`, `STAGE_TYPES`, `type StageType`, `VETO_TYPES`, `type VetoType`, `SCHEDULING_KINDS`, `type Scheduling`.
  - Constants `NAME_MIN = 3`, `NAME_MAX = 60`, `DESCRIPTION_MAX = 4000`, `CANCEL_REASON_MAX = 300`, `POOL_MAX = 12`, `STAGES_MAX = 5`, `PICK_BAN_POOL = 7`, `RESERVED_EVENT_SLUGS: ReadonlySet<string>`.
  - `EVENT_ERRORS` (`Record<key, { status: number; text: string }>`), `type EventError = keyof typeof EVENT_ERRORS`, `type Checked<T> = { ok: true; value: T } | { ok: false; error: EventError }`, `ok<T>(value: T): Checked<T>`, `fail(error: EventError): { ok: false; error: EventError }`.
  - `interface Eligibility { minPugs: number; requireDiscord: boolean; srFloor: number | null; srCeiling: number | null }`, `interface Checkin { enabled: boolean; opensMinutes: number; closesMinutes: number }`, `type RosterLock = { kind: 'none' } | { kind: 'at'; at: string } | { kind: 'after_round'; stage: number; round: number }`, `interface RosterRules { starters: 4; maxSubs: number; lock: RosterLock; maxAdditions: number | null }`.
  - `interface StageConfigs { single_elim: { thirdPlace: boolean }; double_elim: { grandFinalReset: boolean }; round_robin: { groups: number }; swiss: { rounds: number }; league: { weeks: number; matchesPerWeek: number; pairing: 'swiss' | 'round_robin' } }`, `type StageConfig = StageConfigs[StageType]`.
  - `interface StageSettings { type: StageType; config: StageConfig; rulesetId: number; gameConfig: string; campaignPool: string[]; vetoType: VetoType; chapters: number | null; scheduling: Scheduling; advanceCount: number | null }`.
  - `interface StageContext { campaigns: ReadonlySet<string>; rulesetIds: ReadonlySet<number>; gameConfigs: ReadonlySet<string>; defaultPool: string[] }`.
  - `interface EventFields { name: string; startsAt: string; entryKind: EntryKind; official: boolean; teamCap: number | null; description: string; eligibility: Eligibility; checkin: Checkin; roster: RosterRules }`.
  - `defaultEligibility(): Eligibility`, `defaultCheckin(): Checkin`, `defaultRoster(): RosterRules`.
  - `parseTime(v: unknown): string | null`, `normalizeEventName(raw: unknown): Checked<string>`, `normalizeDescription(raw: unknown): Checked<string>`, `normalizeReason(raw: unknown): Checked<string | null>`, `eventSlugBase(name: string): string`.
  - `parseEligibility(raw: unknown): Checked<Eligibility>`, `parseCheckin(raw: unknown): Checked<Checkin>`, `parseRoster(raw: unknown): Checked<RosterRules>`, `parseEventFields(raw: unknown, base: EventFields | null): Checked<EventFields>`.
  - `parseStageConfig(type: StageType, raw: unknown): Checked<StageConfig>`, `parsePool(raw: unknown, allowed: ReadonlySet<string>): Checked<string[]>`, `poolFitsVeto(veto: VetoType, size: number): boolean`, `parseStage(raw: unknown, ctx: StageContext): Checked<StageSettings>`.
  - `checkChain(stages: { advanceCount: number | null }[], o: { teamCap: number | null; roster: RosterRules }): Checked<null>`.
  - `EVENT_EDITABLE: ReadonlySet<EventStatus>` (draft, announced, registration), `STAGES_LOCKED: ReadonlySet<EventStatus>` (live, finished, cancelled), `nextStatusAllowed(from: EventStatus, to: EventStatus): boolean`.
- Produces (`src/events/format.ts`): `STAGE_LABEL: Record<StageType, string>`, `VETO_LABEL: Record<VetoType, string>`, `stageSummary(type: StageType, config: StageConfig, advanceCount: number | null): string`, `chaptersLabel(chapters: number | null): string`, `rulesLines(r: MatchRules): string[]`.

- [ ] **Step 1: Write the failing tests**

`tests/eventsValidate.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import * as V from '../src/events/validate.js';

const CTX: V.StageContext = {
  campaigns: new Set(['no_mercy', 'death_toll', 'dead_air', 'blood_harvest', 'dead_center', 'dark_carnival', 'swamp_fever', 'hard_rain']),
  rulesetIds: new Set([1, 2]),
  gameConfigs: new Set(['standard']),
  defaultPool: ['no_mercy', 'death_toll', 'dead_air', 'blood_harvest'],
};
const SEVEN = ['no_mercy', 'death_toll', 'dead_air', 'blood_harvest', 'dead_center', 'dark_carnival', 'swamp_fever'];
const bad = (r: V.Checked<unknown>): V.EventError | null => (r.ok ? null : r.error);
const stage = (over: Record<string, unknown> = {}) => ({ type: 'swiss', config: { rounds: 4 }, rulesetId: 2, ...over });

describe('names, slugs, descriptions, reasons, times', () => {
  it('trims and folds spaces, and holds a name to 3 to 60 characters of plain text', () => {
    expect(V.normalizeEventName('  Riverside   Cup  ')).toEqual({ ok: true, value: 'Riverside Cup' });
    expect(bad(V.normalizeEventName('ab'))).toBe('bad_name');
    expect(bad(V.normalizeEventName('x'.repeat(61)))).toBe('bad_name');
    expect(bad(V.normalizeEventName('\u2800\u2800\u2800'))).toBe('bad_name');
    expect(bad(V.normalizeEventName(42))).toBe('bad_name');
  });

  it('makes a slug base from the name, with a fallback for a name of symbols', () => {
    expect(V.eventSlugBase('Riverside Cup #1!')).toBe('riverside-cup-1');
    expect(V.eventSlugBase('Café Clash')).toBe('cafe-clash');
    expect(V.eventSlugBase('!!!')).toBe('event');
    for (const w of ['new', 'edit', 'options']) expect(V.RESERVED_EVENT_SLUGS.has(w)).toBe(true);
  });

  it('keeps a description as typed, line breaks included, up to 4000 characters', () => {
    expect(V.normalizeDescription('Line one\r\nLine two\n')).toEqual({ ok: true, value: 'Line one\nLine two' });
    expect(V.normalizeDescription(undefined)).toEqual({ ok: true, value: '' });
    expect(V.normalizeDescription('<b>bold</b>')).toEqual({ ok: true, value: '<b>bold</b>' });
    expect(bad(V.normalizeDescription('x'.repeat(4001)))).toBe('bad_description');
    expect(bad(V.normalizeDescription(7))).toBe('bad_description');
  });

  it('a cancel reason is optional, one line and short', () => {
    expect(V.normalizeReason(undefined)).toEqual({ ok: true, value: null });
    expect(V.normalizeReason('   ')).toEqual({ ok: true, value: null });
    expect(V.normalizeReason(' Not enough\nteams ')).toEqual({ ok: true, value: 'Not enough teams' });
    expect(bad(V.normalizeReason('x'.repeat(301)))).toBe('bad_reason');
  });

  it('reads a time with a zone into UTC and refuses anything else', () => {
    expect(V.parseTime('2026-10-10T20:00:00+02:00')).toBe('2026-10-10T18:00:00.000Z');
    expect(V.parseTime('2026-10-10T20:00:00.000Z')).toBe('2026-10-10T20:00:00.000Z');
    expect(V.parseTime('2026-10-10')).toBeNull();
    expect(V.parseTime('soon')).toBeNull();
    expect(V.parseTime(0)).toBeNull();
  });
});

describe('eligibility, check-in and roster rules', () => {
  it('fills defaults, and holds the SR floor below the ceiling', () => {
    expect(V.parseEligibility(undefined)).toEqual({ ok: true, value: { minPugs: 5, requireDiscord: true, srFloor: null, srCeiling: null } });
    expect(V.parseEligibility({ minPugs: 0, srFloor: 1000 })).toEqual({ ok: true, value: { minPugs: 0, requireDiscord: true, srFloor: 1000, srCeiling: null } });
    expect(bad(V.parseEligibility({ srFloor: 2000, srCeiling: 1500 }))).toBe('bad_eligibility');
    expect(bad(V.parseEligibility({ minPugs: -1 }))).toBe('bad_eligibility');
    expect(bad(V.parseEligibility({ requireDiscord: 'yes' }))).toBe('bad_eligibility');
    expect(bad(V.parseEligibility([]))).toBe('bad_eligibility');
  });

  it('check-in is on by default, 60 to 15 minutes before, and closes at least 5 minutes after it opens', () => {
    expect(V.parseCheckin(undefined)).toEqual({ ok: true, value: { enabled: true, opensMinutes: 60, closesMinutes: 15 } });
    expect(V.parseCheckin({ enabled: false })).toEqual({ ok: true, value: { enabled: false, opensMinutes: 60, closesMinutes: 15 } });
    expect(bad(V.parseCheckin({ opensMinutes: 30, closesMinutes: 26 }))).toBe('bad_checkin');
    expect(V.parseCheckin({ opensMinutes: 30, closesMinutes: 25 }).ok).toBe(true);
    expect(bad(V.parseCheckin({ opensMinutes: 5 }))).toBe('bad_checkin');
  });

  it('a roster has 4 starters, 0 to 4 subs and one of the three locks', () => {
    expect(V.parseRoster(undefined)).toEqual({ ok: true, value: { starters: 4, maxSubs: 2, lock: { kind: 'none' }, maxAdditions: null } });
    expect(V.parseRoster({ lock: { kind: 'at', at: '2026-10-20T00:00:00+00:00' } })).toEqual({
      ok: true, value: { starters: 4, maxSubs: 2, lock: { kind: 'at', at: '2026-10-20T00:00:00.000Z' }, maxAdditions: null },
    });
    expect(V.parseRoster({ maxSubs: 4, lock: { kind: 'after_round', stage: 1, round: 3 }, maxAdditions: 2 }).ok).toBe(true);
    expect(bad(V.parseRoster({ starters: 5 }))).toBe('bad_roster');
    expect(bad(V.parseRoster({ maxSubs: 5 }))).toBe('bad_roster');
    expect(bad(V.parseRoster({ lock: { kind: 'at', at: 'later' } }))).toBe('bad_roster');
    expect(bad(V.parseRoster({ lock: { kind: 'after_round', stage: 0, round: 1 } }))).toBe('bad_roster');
    expect(bad(V.parseRoster({ lock: { kind: 'forever' } }))).toBe('bad_roster');
  });
});

describe('event fields', () => {
  const START = '2026-10-10T20:00:00.000Z';
  it('a new event needs a name, a start and an entry kind, and takes the defaults for the rest', () => {
    expect(V.parseEventFields({ name: 'Cup', startsAt: START, entryKind: 'team' }, null)).toEqual({
      ok: true,
      value: {
        name: 'Cup', startsAt: START, entryKind: 'team', official: true, teamCap: null, description: '',
        eligibility: V.defaultEligibility(), checkin: V.defaultCheckin(), roster: V.defaultRoster(),
      },
    });
    expect(bad(V.parseEventFields({ name: 'Cup' }, null))).toBe('missing_fields');
    expect(bad(V.parseEventFields('Cup', null))).toBe('bad_request');
    expect(bad(V.parseEventFields({ name: 'Cup', startsAt: START, entryKind: 'solo' }, null))).toBe('bad_entry_kind');
    expect(bad(V.parseEventFields({ name: 'Cup', startsAt: 'later', entryKind: 'team' }, null))).toBe('bad_start');
  });

  it('an edit changes only what it carries, and null clears the team cap', () => {
    const base = V.parseEventFields({ name: 'Cup', startsAt: START, entryKind: 'team', teamCap: 16 }, null);
    if (!base.ok) throw new Error(base.error);
    expect(V.parseEventFields({ description: 'Hi' }, base.value)).toEqual({ ok: true, value: { ...base.value, description: 'Hi' } });
    expect(V.parseEventFields({ teamCap: null }, base.value)).toEqual({ ok: true, value: { ...base.value, teamCap: null } });
    expect(bad(V.parseEventFields({ teamCap: 1 }, base.value))).toBe('bad_team_cap');
    expect(bad(V.parseEventFields({ official: 'yes' }, base.value))).toBe('bad_request');
  });
});

describe('stages', () => {
  it('fills defaults per type and takes the site pool when none is sent', () => {
    expect(V.parseStage(stage(), CTX)).toEqual({
      ok: true,
      value: {
        type: 'swiss', config: { rounds: 4 }, rulesetId: 2, gameConfig: 'standard', campaignPool: CTX.defaultPool,
        vetoType: 'ban_to_one', chapters: null, scheduling: 'rolling', advanceCount: null,
      },
    });
    expect(V.parseStageConfig('double_elim', undefined)).toEqual({ ok: true, value: { grandFinalReset: true } });
    expect(V.parseStageConfig('league', {})).toEqual({ ok: true, value: { weeks: 6, matchesPerWeek: 1, pairing: 'swiss' } });
    expect(V.parseStageConfig('round_robin', { groups: 2 })).toEqual({ ok: true, value: { groups: 2 } });
  });

  it('holds each type config to its range', () => {
    expect(bad(V.parseStageConfig('swiss', { rounds: 10 }))).toBe('bad_stage_config');
    expect(bad(V.parseStageConfig('round_robin', { groups: 0 }))).toBe('bad_stage_config');
    expect(bad(V.parseStageConfig('league', { pairing: 'random' }))).toBe('bad_stage_config');
    expect(bad(V.parseStageConfig('single_elim', { thirdPlace: 1 }))).toBe('bad_stage_config');
  });

  it('refuses an unknown type, an archived ruleset, a config that is off, and a bad chapter count', () => {
    expect(bad(V.parseStage(stage({ type: 'ladder' }), CTX))).toBe('bad_stage_type');
    expect(bad(V.parseStage(stage({ rulesetId: 9 }), CTX))).toBe('bad_ruleset');
    expect(bad(V.parseStage(stage({ gameConfig: 'zonemod' }), CTX))).toBe('bad_game_config');
    expect(bad(V.parseStage(stage({ chapters: 6 }), CTX))).toBe('bad_chapters');
    expect(V.parseStage(stage({ chapters: 3 }), CTX).ok).toBe(true);
    expect(bad(V.parseStage(stage({ advanceCount: 1 }), CTX))).toBe('bad_advance');
    expect(bad(V.parseStage([], CTX))).toBe('bad_request');
  });

  it('a pool is 1 to 12 different poolable campaigns, sized for its veto', () => {
    expect(bad(V.parseStage(stage({ campaignPool: [] }), CTX))).toBe('bad_pool');
    expect(bad(V.parseStage(stage({ campaignPool: ['no_mercy', 'no_mercy'] }), CTX))).toBe('bad_pool');
    expect(bad(V.parseStage(stage({ campaignPool: ['not_a_campaign'] }), CTX))).toBe('bad_pool');
    expect(V.parseStage(stage({ campaignPool: ['no_mercy'] }), CTX).ok).toBe(true);
    expect(bad(V.parseStage(stage({ campaignPool: ['no_mercy'], vetoType: 'home_away' }), CTX))).toBe('bad_pool_for_veto');
    expect(bad(V.parseStage(stage({ campaignPool: SEVEN.slice(0, 6), vetoType: 'pick_ban' }), CTX))).toBe('bad_pool_for_veto');
    expect(V.parseStage(stage({ campaignPool: SEVEN, vetoType: 'pick_ban' }), CTX).ok).toBe(true);
    expect(bad(V.parseStage(stage({ vetoType: 'coin' }), CTX))).toBe('bad_veto');
  });

  it('a league is always played in windows', () => {
    const r = V.parseStage(stage({ type: 'league', config: {} }), CTX);
    expect(r.ok && r.value.scheduling).toBe('window');
    expect(bad(V.parseStage(stage({ type: 'league', config: {}, scheduling: 'rolling' }), CTX))).toBe('league_needs_window');
    expect(bad(V.parseStage(stage({ scheduling: 'weekly' }), CTX))).toBe('bad_scheduling');
  });
});

describe('the stage chain', () => {
  const roster = V.defaultRoster();
  it('needs a stage, an advance count on every stage but the last, each smaller than the one before and the cap', () => {
    expect(bad(V.checkChain([], { teamCap: null, roster }))).toBe('no_stages');
    expect(V.checkChain([{ advanceCount: null }], { teamCap: null, roster })).toEqual({ ok: true, value: null });
    expect(V.checkChain([{ advanceCount: 8 }, { advanceCount: 4 }, { advanceCount: null }], { teamCap: 16, roster }).ok).toBe(true);
    expect(bad(V.checkChain([{ advanceCount: 8 }], { teamCap: null, roster }))).toBe('bad_chain');
    expect(bad(V.checkChain([{ advanceCount: null }, { advanceCount: null }], { teamCap: null, roster }))).toBe('bad_chain');
    expect(bad(V.checkChain([{ advanceCount: 4 }, { advanceCount: 8 }, { advanceCount: null }], { teamCap: null, roster }))).toBe('bad_chain');
    expect(bad(V.checkChain([{ advanceCount: 16 }, { advanceCount: null }], { teamCap: 16, roster }))).toBe('bad_chain');
  });

  it('a roster lock after a round must point at a stage that exists', () => {
    const late: V.RosterRules = { ...roster, lock: { kind: 'after_round', stage: 2, round: 1 } };
    expect(bad(V.checkChain([{ advanceCount: null }], { teamCap: null, roster: late }))).toBe('bad_roster');
    expect(V.checkChain([{ advanceCount: 4 }, { advanceCount: null }], { teamCap: null, roster: late }).ok).toBe(true);
  });
});

describe('status rules', () => {
  it('T1a moves draft to announced to registration, and cancels anything not over', () => {
    expect(V.nextStatusAllowed('draft', 'announced')).toBe(true);
    expect(V.nextStatusAllowed('announced', 'registration')).toBe(true);
    expect(V.nextStatusAllowed('draft', 'registration')).toBe(false);
    expect(V.nextStatusAllowed('registration', 'checkin')).toBe(false);
    for (const s of ['draft', 'announced', 'registration', 'checkin', 'live'] as const) expect(V.nextStatusAllowed(s, 'cancelled')).toBe(true);
    expect(V.nextStatusAllowed('finished', 'cancelled')).toBe(false);
    expect(V.nextStatusAllowed('cancelled', 'cancelled')).toBe(false);
  });

  it('events are edited until registration closes; stages until the event is live', () => {
    expect([...V.EVENT_EDITABLE]).toEqual(['draft', 'announced', 'registration']);
    expect([...V.STAGES_LOCKED]).toEqual(['live', 'finished', 'cancelled']);
  });

  it('every error has a status and a sentence', () => {
    for (const [k, e] of Object.entries(V.EVENT_ERRORS)) {
      expect([400, 404, 409]).toContain(e.status);
      expect(e.text.length, k).toBeGreaterThan(10);
      expect(e.text.includes(String.fromCharCode(0x2014)), k).toBe(false);
    }
  });
});
```

`tests/eventFormat.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { chaptersLabel, rulesLines, stageSummary } from '../src/events/format.js';
import { TEMPLATES } from '../src/rulesets.js';

describe('stage summary', () => {
  it('reads each type with its settings and the advance count', () => {
    expect(stageSummary('swiss', { rounds: 4 }, 8)).toBe('Swiss, 4 rounds, top 8 advance');
    expect(stageSummary('single_elim', { thirdPlace: true }, null)).toBe('Single elimination, third-place match');
    expect(stageSummary('single_elim', { thirdPlace: false }, null)).toBe('Single elimination');
    expect(stageSummary('double_elim', { grandFinalReset: false }, null)).toBe('Double elimination, no grand final reset');
    expect(stageSummary('round_robin', { groups: 1 }, 4)).toBe('Round robin, top 4 advance');
    expect(stageSummary('round_robin', { groups: 2 }, 4)).toBe('Round robin, 2 groups, top 4 advance');
    expect(stageSummary('league', { weeks: 6, matchesPerWeek: 2, pairing: 'swiss' }, 4)).toBe('League, 6 weeks, 2 a week, top 4 advance');
  });

  it('labels chapters', () => {
    expect(chaptersLabel(null)).toBe('Every chapter but the finale');
    expect(chaptersLabel(1)).toBe('1 chapter');
    expect(chaptersLabel(3)).toBe('3 chapters');
  });
});

describe('rules lines', () => {
  it('reads the Standard Cup template', () => {
    expect(rulesLines(TEMPLATES['Standard Cup'])).toEqual([
      'Pauses: 3 per team, up to 120 s each',
      'Unpausing needs both teams',
      'Technical pauses: 2 per team',
      'No-show grace: 15 minutes',
      'Higher seed picks sides',
      'Boss spawns: random, shown in game',
      'Teams are locked once the match is live',
      'Team spectators see only their own side',
    ]);
  });

  it('reads the Casual Scrim template', () => {
    expect(rulesLines(TEMPLATES['Casual Scrim'])).toEqual([
      'Pauses: no limit',
      'Unpausing needs both teams',
      'No-show grace: 15 minutes',
      'The team that did not pick the campaign picks sides',
      'Boss spawns: random, shown in game',
      'Teams are locked once the match is live',
      'A half can be restarted',
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/eventsValidate.test.ts tests/eventFormat.test.ts`
Expected: FAIL with `Cannot find module '../src/events/validate.js'` and `'../src/events/format.js'`.

- [ ] **Step 3: Write `src/events/validate.ts`**

```ts
import { findSlurs } from '../slurs.js';
import { hasUnsafeChars } from '../profileFields.js';

/**
 * Every rule about an event's and a stage's settings (tournaments spec part
 * 2, sections 1 and 2; plan T1a). Pure: the lists a stage is checked against
 * (poolable campaigns, live rulesets, enabled game configs, the site pool)
 * come in as a StageContext, so the whole module is tested without a
 * database. src/events/events.ts calls it on every write, and again at
 * publish with the lists of that moment.
 */

export const EVENT_STATUSES = ['draft', 'announced', 'registration', 'checkin', 'live', 'finished', 'cancelled'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];
export const ENTRY_KINDS = ['team', 'draft'] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];
export const STAGE_TYPES = ['single_elim', 'double_elim', 'round_robin', 'swiss', 'league'] as const;
export type StageType = (typeof STAGE_TYPES)[number];
export const VETO_TYPES = ['ban_to_one', 'home_away', 'pick_ban'] as const;
export type VetoType = (typeof VETO_TYPES)[number];
export const SCHEDULING_KINDS = ['rolling', 'window'] as const;
export type Scheduling = (typeof SCHEDULING_KINDS)[number];

export const NAME_MIN = 3;
export const NAME_MAX = 60;
export const DESCRIPTION_MAX = 4000;
export const CANCEL_REASON_MAX = 300;
export const POOL_MAX = 12;
export const STAGES_MAX = 5;
/** ban, ban, pick, pick, ban, ban, decider (spec section 4, pick_ban). */
export const PICK_BAN_POOL = 7;
/** Words the routes use for themselves, or may later. */
export const RESERVED_EVENT_SLUGS: ReadonlySet<string> = new Set(['new', 'edit', 'mine', 'admin', 'logos', 'banners', 'options']);

export const EVENT_ERRORS = {
  bad_request: { status: 400, text: 'That request is not one this form sends.' },
  missing_fields: { status: 400, text: 'An event needs a name, a start time and an entry kind.' },
  bad_name: { status: 400, text: `An event name is ${NAME_MIN} to ${NAME_MAX} characters of plain text.` },
  name_not_allowed: { status: 400, text: 'That name is not allowed here.' },
  bad_description: { status: 400, text: `The description is at most ${DESCRIPTION_MAX} characters, with no control characters.` },
  bad_start: { status: 400, text: 'The start time is not a date and time.' },
  start_passed: { status: 400, text: 'The start time has to be in the future.' },
  bad_entry_kind: { status: 400, text: 'Entries are teams or a draft.' },
  bad_team_cap: { status: 400, text: 'A team cap is 2 to 256 teams, or none.' },
  bad_eligibility: { status: 400, text: 'Eligibility: minimum PUGs 0 to 1000, and an SR floor below the SR ceiling.' },
  bad_checkin: { status: 400, text: 'Check-in opens 10 to 1440 minutes before the start and closes at least 5 minutes after it opens.' },
  bad_roster: { status: 400, text: 'Roster rules: 4 starters, 0 to 4 subs, and a lock that points at a real stage and round.' },
  bad_stage_type: { status: 400, text: 'A stage is single elimination, double elimination, round robin, Swiss or league.' },
  bad_stage_config: { status: 400, text: 'Those stage settings are out of range.' },
  bad_ruleset: { status: 400, text: 'Pick a ruleset that is not archived.' },
  bad_game_config: { status: 400, text: 'Pick a game config that is turned on.' },
  bad_pool: { status: 400, text: `A campaign pool is 1 to ${POOL_MAX} different campaigns from the poolable list.` },
  bad_pool_for_veto: { status: 400, text: `Home and away needs at least 2 campaigns; pick and ban needs exactly ${PICK_BAN_POOL}.` },
  bad_veto: { status: 400, text: 'The veto is ban to one, home and away, or pick and ban.' },
  bad_chapters: { status: 400, text: 'Chapters is standard, or 1 to 5.' },
  bad_scheduling: { status: 400, text: 'Scheduling is rolling or in windows.' },
  league_needs_window: { status: 400, text: 'A league stage is played in scheduled windows.' },
  bad_advance: { status: 400, text: 'An advance count is 2 to 128 teams.' },
  bad_chain: { status: 400, text: 'Every stage but the last needs an advance count, smaller than the stage before it and the team cap; the last stage has none.' },
  bad_order: { status: 400, text: 'The new order must list every stage of this event once.' },
  bad_reason: { status: 400, text: `A reason is one line of at most ${CANCEL_REASON_MAX} characters.` },
  no_stages: { status: 409, text: 'Add at least one stage first.' },
  too_many_stages: { status: 409, text: `An event has at most ${STAGES_MAX} stages.` },
  not_found: { status: 404, text: 'No such event.' },
  stage_not_found: { status: 404, text: 'No such stage on this event.' },
  wrong_status: { status: 409, text: 'The event is not at a step that allows that.' },
  stages_locked: { status: 409, text: 'Stages cannot change once the event is live.' },
  kind_locked: { status: 409, text: 'The entry kind can only change while the event is a draft.' },
  draft_signups_later: { status: 409, text: 'Signups for a draft event arrive with the draft plan.' },
} as const satisfies Record<string, { status: number; text: string }>;
export type EventError = keyof typeof EVENT_ERRORS;

export type Checked<T> = { ok: true; value: T } | { ok: false; error: EventError };
export const ok = <T>(value: T): Checked<T> => ({ ok: true, value });
export const fail = (error: EventError): { ok: false; error: EventError } => ({ ok: false, error });

export interface Eligibility { minPugs: number; requireDiscord: boolean; srFloor: number | null; srCeiling: number | null }
export interface Checkin { enabled: boolean; opensMinutes: number; closesMinutes: number }
export type RosterLock = { kind: 'none' } | { kind: 'at'; at: string } | { kind: 'after_round'; stage: number; round: number };
export interface RosterRules { starters: 4; maxSubs: number; lock: RosterLock; maxAdditions: number | null }

export interface StageConfigs {
  single_elim: { thirdPlace: boolean };
  double_elim: { grandFinalReset: boolean };
  round_robin: { groups: number };
  swiss: { rounds: number };
  league: { weeks: number; matchesPerWeek: number; pairing: 'swiss' | 'round_robin' };
}
export type StageConfig = StageConfigs[StageType];

export interface StageSettings {
  type: StageType; config: StageConfig; rulesetId: number; gameConfig: string; campaignPool: string[];
  vetoType: VetoType; chapters: number | null; scheduling: Scheduling; advanceCount: number | null;
}
export interface StageContext {
  campaigns: ReadonlySet<string>; rulesetIds: ReadonlySet<number>; gameConfigs: ReadonlySet<string>; defaultPool: string[];
}
export interface EventFields {
  name: string; startsAt: string; entryKind: EntryKind; official: boolean; teamCap: number | null; description: string;
  eligibility: Eligibility; checkin: Checkin; roster: RosterRules;
}

export const defaultEligibility = (): Eligibility => ({ minPugs: 5, requireDiscord: true, srFloor: null, srCeiling: null });
export const defaultCheckin = (): Checkin => ({ enabled: true, opensMinutes: 60, closesMinutes: 15 });
export const defaultRoster = (): RosterRules => ({ starters: 4, maxSubs: 2, lock: { kind: 'none' }, maxAdditions: null });

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown, min: number, max: number): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
/** null (or absent) is null; an integer in range is itself; anything else undefined. */
const intOrNull = (v: unknown, min: number, max: number): number | null | undefined =>
  v === null || v === undefined ? null : isInt(v, min, max) ? v : undefined;
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);

/** An ISO date and time with a zone, as UTC; null for anything else. */
export function parseTime(v: unknown): string | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Invisible-by-design code points; see the same rule in src/teams/teams.ts. */
const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;

export function normalizeEventName(raw: unknown): Checked<string> {
  if (typeof raw !== 'string') return fail('bad_name');
  const name = raw.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (name.length < NAME_MIN || name.length > NAME_MAX || hasUnsafeChars(name) || DEFAULT_IGNORABLE.test(name) || !/[\p{L}\p{N}]/u.test(name)) {
    return fail('bad_name');
  }
  if (findSlurs(name).length > 0) return fail('name_not_allowed');
  return ok(name);
}

/** Stored as typed, line breaks kept; the web formats it with the safe
 *  markdown subset (Ruling 1), so nothing here interprets it. */
export function normalizeDescription(raw: unknown): Checked<string> {
  if (raw === undefined || raw === null) return ok('');
  if (typeof raw !== 'string') return fail('bad_description');
  const text = raw.normalize('NFC').replace(/\r\n?/g, '\n').trim();
  if (text.length > DESCRIPTION_MAX || hasUnsafeChars(text, true)) return fail('bad_description');
  return ok(text);
}

export function normalizeReason(raw: unknown): Checked<string | null> {
  if (raw === undefined || raw === null) return ok(null);
  if (typeof raw !== 'string') return fail('bad_reason');
  const text = raw.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (text.length > CANCEL_REASON_MAX || hasUnsafeChars(text)) return fail('bad_reason');
  return ok(text === '' ? null : text);
}

/** The slug a name would like; src/events/events.ts makes it unique. */
export function eventSlugBase(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 48).replace(/-+$/, '') || 'event';
}

export function parseEligibility(raw: unknown): Checked<Eligibility> {
  if (raw === undefined) return ok(defaultEligibility());
  if (!isObj(raw)) return fail('bad_eligibility');
  const d = defaultEligibility();
  const minPugs = raw.minPugs ?? d.minPugs;
  const requireDiscord = raw.requireDiscord ?? d.requireDiscord;
  const srFloor = intOrNull(raw.srFloor, 0, 10000);
  const srCeiling = intOrNull(raw.srCeiling, 0, 10000);
  if (!isInt(minPugs, 0, 1000) || typeof requireDiscord !== 'boolean' || srFloor === undefined || srCeiling === undefined) {
    return fail('bad_eligibility');
  }
  if (srFloor !== null && srCeiling !== null && srFloor >= srCeiling) return fail('bad_eligibility');
  return ok({ minPugs, requireDiscord, srFloor, srCeiling });
}

export function parseCheckin(raw: unknown): Checked<Checkin> {
  if (raw === undefined) return ok(defaultCheckin());
  if (!isObj(raw)) return fail('bad_checkin');
  const d = defaultCheckin();
  const enabled = raw.enabled ?? d.enabled;
  const opensMinutes = raw.opensMinutes ?? d.opensMinutes;
  const closesMinutes = raw.closesMinutes ?? d.closesMinutes;
  if (typeof enabled !== 'boolean' || !isInt(opensMinutes, 10, 1440) || !isInt(closesMinutes, 0, 1440)) return fail('bad_checkin');
  if (closesMinutes > opensMinutes - 5) return fail('bad_checkin');
  return ok({ enabled, opensMinutes, closesMinutes });
}

function parseLock(raw: unknown): RosterLock | null {
  if (raw === undefined) return { kind: 'none' };
  if (!isObj(raw)) return null;
  if (raw.kind === 'none') return { kind: 'none' };
  if (raw.kind === 'at') {
    const at = parseTime(raw.at);
    return at ? { kind: 'at', at } : null;
  }
  if (raw.kind === 'after_round') {
    const stage = raw.stage;
    const round = raw.round;
    return isInt(stage, 1, STAGES_MAX) && isInt(round, 1, 20) ? { kind: 'after_round', stage, round } : null;
  }
  return null;
}

export function parseRoster(raw: unknown): Checked<RosterRules> {
  if (raw === undefined) return ok(defaultRoster());
  if (!isObj(raw)) return fail('bad_roster');
  if ((raw.starters ?? 4) !== 4) return fail('bad_roster');
  const maxSubs = raw.maxSubs ?? defaultRoster().maxSubs;
  const maxAdditions = intOrNull(raw.maxAdditions, 0, 20);
  const lock = parseLock(raw.lock);
  if (!isInt(maxSubs, 0, 4) || maxAdditions === undefined || lock === null) return fail('bad_roster');
  return ok({ starters: 4, maxSubs, lock, maxAdditions });
}

/**
 * A whole EventFields from a request body. With base null it is a create:
 * name, startsAt and entryKind are required and the rest take their
 * defaults. With a base it is an edit: only the keys present change.
 */
export function parseEventFields(raw: unknown, base: EventFields | null): Checked<EventFields> {
  if (!isObj(raw)) return fail('bad_request');
  const has = (k: string) => raw[k] !== undefined;
  if (!base && (!has('name') || !has('startsAt') || !has('entryKind'))) return fail('missing_fields');
  const out: EventFields = base ? { ...base } : {
    name: '', startsAt: '', entryKind: 'team', official: true, teamCap: null, description: '',
    eligibility: defaultEligibility(), checkin: defaultCheckin(), roster: defaultRoster(),
  };
  if (has('name')) {
    const r = normalizeEventName(raw.name);
    if (!r.ok) return r;
    out.name = r.value;
  }
  if (has('startsAt')) {
    const t = parseTime(raw.startsAt);
    if (!t) return fail('bad_start');
    out.startsAt = t;
  }
  if (has('entryKind')) {
    const k = raw.entryKind;
    if (!oneOf(ENTRY_KINDS, k)) return fail('bad_entry_kind');
    out.entryKind = k;
  }
  if (has('official')) {
    const o = raw.official;
    if (typeof o !== 'boolean') return fail('bad_request');
    out.official = o;
  }
  if ('teamCap' in raw) {
    const c = intOrNull(raw.teamCap, 2, 256);
    if (c === undefined) return fail('bad_team_cap');
    out.teamCap = c;
  }
  if (has('description')) {
    const r = normalizeDescription(raw.description);
    if (!r.ok) return r;
    out.description = r.value;
  }
  if (has('eligibility')) {
    const r = parseEligibility(raw.eligibility);
    if (!r.ok) return r;
    out.eligibility = r.value;
  }
  if (has('checkin')) {
    const r = parseCheckin(raw.checkin);
    if (!r.ok) return r;
    out.checkin = r.value;
  }
  if (has('roster')) {
    const r = parseRoster(raw.roster);
    if (!r.ok) return r;
    out.roster = r.value;
  }
  return ok(out);
}

export function parseStageConfig(type: StageType, raw: unknown): Checked<StageConfig> {
  const c = raw === undefined ? {} : raw;
  if (!isObj(c)) return fail('bad_stage_config');
  switch (type) {
    case 'single_elim': {
      const thirdPlace = c.thirdPlace ?? false;
      return typeof thirdPlace === 'boolean' ? ok({ thirdPlace }) : fail('bad_stage_config');
    }
    case 'double_elim': {
      const grandFinalReset = c.grandFinalReset ?? true;
      return typeof grandFinalReset === 'boolean' ? ok({ grandFinalReset }) : fail('bad_stage_config');
    }
    case 'round_robin': {
      const groups = c.groups ?? 1;
      return isInt(groups, 1, 8) ? ok({ groups }) : fail('bad_stage_config');
    }
    case 'swiss': {
      const rounds = c.rounds ?? 4;
      return isInt(rounds, 1, 9) ? ok({ rounds }) : fail('bad_stage_config');
    }
    case 'league': {
      const weeks = c.weeks ?? 6;
      const matchesPerWeek = c.matchesPerWeek ?? 1;
      const pairing = c.pairing ?? 'swiss';
      return isInt(weeks, 1, 12) && isInt(matchesPerWeek, 1, 3) && oneOf(['swiss', 'round_robin'] as const, pairing)
        ? ok({ weeks, matchesPerWeek, pairing })
        : fail('bad_stage_config');
    }
  }
}

export function parsePool(raw: unknown, allowed: ReadonlySet<string>): Checked<string[]> {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > POOL_MAX) return fail('bad_pool');
  const out: string[] = [];
  for (const c of raw) {
    if (typeof c !== 'string' || !allowed.has(c) || out.includes(c)) return fail('bad_pool');
    out.push(c);
  }
  return ok(out);
}

/** Enough campaigns for the veto to run (spec section 4). */
export function poolFitsVeto(veto: VetoType, size: number): boolean {
  if (veto === 'home_away') return size >= 2;
  if (veto === 'pick_ban') return size === PICK_BAN_POOL;
  return size >= 1;
}

export function parseStage(raw: unknown, ctx: StageContext): Checked<StageSettings> {
  if (!isObj(raw)) return fail('bad_request');
  const type = raw.type;
  if (!oneOf(STAGE_TYPES, type)) return fail('bad_stage_type');
  const config = parseStageConfig(type, raw.config);
  if (!config.ok) return config;
  const rulesetId = raw.rulesetId;
  if (!Number.isInteger(rulesetId) || !ctx.rulesetIds.has(rulesetId as number)) return fail('bad_ruleset');
  const gameConfig = raw.gameConfig ?? 'standard';
  if (typeof gameConfig !== 'string' || !ctx.gameConfigs.has(gameConfig)) return fail('bad_game_config');
  const pool = parsePool(raw.campaignPool ?? ctx.defaultPool, ctx.campaigns);
  if (!pool.ok) return pool;
  const vetoType = raw.vetoType ?? 'ban_to_one';
  if (!oneOf(VETO_TYPES, vetoType)) return fail('bad_veto');
  if (!poolFitsVeto(vetoType, pool.value.length)) return fail('bad_pool_for_veto');
  const chapters = intOrNull(raw.chapters, 1, 5);
  if (chapters === undefined) return fail('bad_chapters');
  const scheduling = raw.scheduling ?? (type === 'league' ? 'window' : 'rolling');
  if (!oneOf(SCHEDULING_KINDS, scheduling)) return fail('bad_scheduling');
  if (type === 'league' && scheduling !== 'window') return fail('league_needs_window');
  const advanceCount = intOrNull(raw.advanceCount, 2, 128);
  if (advanceCount === undefined) return fail('bad_advance');
  return ok({
    type, config: config.value, rulesetId: rulesetId as number, gameConfig, campaignPool: pool.value,
    vetoType, chapters, scheduling, advanceCount,
  });
}

/** The chain of stages as a whole (Ruling 16): checked at publish and at
 *  open registration, not on every edit. */
export function checkChain(stages: { advanceCount: number | null }[], o: { teamCap: number | null; roster: RosterRules }): Checked<null> {
  if (stages.length === 0) return fail('no_stages');
  for (let i = 0; i < stages.length; i++) {
    const a = stages[i].advanceCount;
    if (i === stages.length - 1) {
      if (a !== null) return fail('bad_chain');
      continue;
    }
    if (a === null) return fail('bad_chain');
    const before = i > 0 ? stages[i - 1].advanceCount : null;
    if (before !== null && a >= before) return fail('bad_chain');
    if (o.teamCap !== null && a >= o.teamCap) return fail('bad_chain');
  }
  if (o.roster.lock.kind === 'after_round' && o.roster.lock.stage > stages.length) return fail('bad_roster');
  return ok(null);
}

export const EVENT_EDITABLE: ReadonlySet<EventStatus> = new Set<EventStatus>(['draft', 'announced', 'registration']);
export const STAGES_LOCKED: ReadonlySet<EventStatus> = new Set<EventStatus>(['live', 'finished', 'cancelled']);

/** The moves T1a makes (Ruling 3); check-in, live and finished come later. */
export function nextStatusAllowed(from: EventStatus, to: EventStatus): boolean {
  if (to === 'cancelled') return from !== 'finished' && from !== 'cancelled';
  return (from === 'draft' && to === 'announced') || (from === 'announced' && to === 'registration');
}
```

- [ ] **Step 4: Write `src/events/format.ts`**

```ts
import type { MatchRules } from '../rulesets.js';
import type { StageConfig, StageConfigs, StageType, VetoType } from './validate.js';

/** What the event page and the desk say about a stage and its rules. */

export const STAGE_LABEL: Record<StageType, string> = {
  single_elim: 'Single elimination', double_elim: 'Double elimination', round_robin: 'Round robin', swiss: 'Swiss', league: 'League',
};
export const VETO_LABEL: Record<VetoType, string> = {
  ban_to_one: 'Ban to one (Bo1)', home_away: 'Home and away (Bo2 aggregate)', pick_ban: 'Pick and ban (Bo3)',
};

type AnyConfig = Partial<StageConfigs['single_elim'] & StageConfigs['double_elim'] & StageConfigs['round_robin'] & StageConfigs['swiss'] & StageConfigs['league']>;

export function stageSummary(type: StageType, config: StageConfig, advanceCount: number | null): string {
  const c = config as AnyConfig;
  const parts: string[] = [STAGE_LABEL[type]];
  if (type === 'single_elim' && c.thirdPlace) parts.push('third-place match');
  if (type === 'double_elim') parts.push(c.grandFinalReset ? 'grand final reset' : 'no grand final reset');
  if (type === 'round_robin' && (c.groups ?? 1) > 1) parts.push(`${c.groups} groups`);
  if (type === 'swiss') parts.push(`${c.rounds} rounds`);
  if (type === 'league') parts.push(`${c.weeks} weeks`, `${c.matchesPerWeek} a week`);
  if (advanceCount !== null) parts.push(`top ${advanceCount} advance`);
  return parts.join(', ');
}

export function chaptersLabel(chapters: number | null): string {
  return chapters === null ? 'Every chapter but the finale' : `${chapters} chapter${chapters === 1 ? '' : 's'}`;
}

const SIDE_RULE: Record<MatchRules['sideRule'], string> = {
  higher_seed_chooses: 'Higher seed picks sides',
  non_picker_chooses: 'The team that did not pick the campaign picks sides',
  coin: 'Sides by coin toss',
};
const BOSSES: Record<MatchRules['bosses'], string> = {
  random_published: 'Boss spawns: random, shown in game',
  fixed: 'Boss spawns: fixed',
  voteboss: 'Boss spawns: voted by the teams',
};

/** A ruleset as the lines a player reads. `rated` is left out: a tournament
 *  match is never rated (rulesForKind). */
export function rulesLines(r: MatchRules): string[] {
  const lines: string[] = [];
  lines.push(r.pause.limit === null
    ? 'Pauses: no limit'
    : `Pauses: ${r.pause.limit} per team${r.pause.seconds !== null ? `, up to ${r.pause.seconds} s each` : ''}`);
  if (r.pause.mutualUnpause) lines.push('Unpausing needs both teams');
  if (r.pause.techPauses > 0) lines.push(`Technical pauses: ${r.pause.techPauses} per team`);
  lines.push(`No-show grace: ${r.noShowGraceMinutes} minutes`);
  lines.push(SIDE_RULE[r.sideRule]);
  lines.push(BOSSES[r.bosses]);
  if (r.teamLock) lines.push('Teams are locked once the match is live');
  if (r.restartHalf.allowed) lines.push(r.restartHalf.lockAfterDamage ? 'A half can be restarted until damage is done' : 'A half can be restarted');
  if (r.spectate.sideLocked) lines.push('Team spectators see only their own side');
  return lines;
}
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `npx vitest run tests/eventsValidate.test.ts tests/eventFormat.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/events/validate.ts src/events/format.ts tests/eventsValidate.test.ts tests/eventFormat.test.ts
git commit -m "Events: pure validation for event and stage settings, and the readable stage and rules lines"
```

---
### Task 3: The event store, `event_log`, and the guard tests

**Files:**
- Create: `src/events/events.ts`
- Create: `tests/eventFixture.ts` (shared fixture, not a test file)
- Test: `tests/events.test.ts`, `tests/eventLogGuard.test.ts`

**Interfaces:**
- Consumes: everything Task 2 exports from `src/events/validate.ts` (imported as `V`); `poolableCampaigns(db): CampaignEntry[]` (`src/campaignRegistry.ts`); `getCampaignPool(db): string[]` (`src/settings.ts`); `parseRules(json: string): MatchRules`, `rulesForKind(kind: MatchKind, rules: MatchRules): MatchRules` (`src/rulesets.ts`).
- Produces (`src/events/events.ts`):
  - `interface EventRow { id: number; slug: string; name: string; banner_key: string | null; region: string; organizer_steamid: string; official: number; entry_kind: V.EntryKind; status: V.EventStatus; starts_at: string; description: string; eligibility_json: string; team_cap: number | null; checkin_json: string; roster_json: string; created_at: string; updated_at: string; finished_at: string | null; cancelled_at: string | null; cancel_reason: string | null }`
  - `interface StageRow { id: number; event_id: number; ordinal: number; type: V.StageType; config_json: string; ruleset_id: number; rules_json: string | null; game_config: string; campaign_pool_json: string; veto_type: V.VetoType; chapters: number | null; scheduling: V.Scheduling; advance_count: number | null; status: 'pending' | 'live' | 'finished'; created_at: string; updated_at: string }`
  - `interface EventLogRow { id: number; event_id: number; at: string; actor: string | null; action: string; detail: string }`
  - `type EventResult<T> = V.Checked<T>`
  - Reads: `getEvent(db, id: number): EventRow | undefined`, `getEventBySlug(db, slug: string): EventRow | undefined`, `getStage(db, id: number): StageRow | undefined`, `stagesOf(db, eventId: number): StageRow[]` (by ordinal), `eventLog(db, eventId: number): EventLogRow[]` (oldest first), `fieldsOf(ev: EventRow): V.EventFields`, `stageSettingsOf(s: StageRow): V.StageSettings`, `stageContext(db): V.StageContext`.
  - Mutations (each one transaction, each writes exactly one `event_log` row on success, none on refusal):
    - `createEvent(db, o: { by: string; fields: unknown; now?: Date }): EventResult<EventRow>` (action `created`)
    - `updateEvent(db, o: { eventId: number; by: string; fields: unknown; now?: Date }): EventResult<EventRow>` (`edited`; a no-change edit writes nothing and returns the row)
    - `addStage(db, o: { eventId: number; by: string; stage: unknown; now?: Date }): EventResult<StageRow>` (`stage_added`)
    - `updateStage(db, o: { eventId: number; stageId: number; by: string; stage: unknown; now?: Date }): EventResult<StageRow>` (`stage_edited`)
    - `removeStage(db, o: { eventId: number; stageId: number; by: string; now?: Date }): EventResult<null>` (`stage_removed`)
    - `reorderStages(db, o: { eventId: number; by: string; order: unknown; now?: Date }): EventResult<StageRow[]>` (`stages_reordered`)
    - `publishEvent(db, o: { eventId: number; by: string; now?: Date }): EventResult<EventRow>` (`published`)
    - `openRegistration(db, o: { eventId: number; by: string; now?: Date }): EventResult<EventRow>` (`registration_opened`)
    - `cancelEvent(db, o: { eventId: number; by: string; reason: unknown; now?: Date }): EventResult<EventRow>` (`cancelled`)
- Produces (`tests/eventFixture.ts`): `NOW: Date` (2026-10-01T12:00Z), `START` (`'2026-10-10T20:00:00.000Z'`), `ADMIN` (steamid), `cupId(db): number`, `stageBody(db, over?): Record<string, unknown>`, `must<T>(r: EventResult<T>): T`, `interface Fixture { db: DB; eventId: number; s1: number; s2: number }`, `eventFixture(status?: 'draft' | 'announced'): Fixture`.

- [ ] **Step 1: Write the shared fixture**

`tests/eventFixture.ts`:

```ts
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer } from '../src/players.js';
import * as E from '../src/events/events.js';

/** Shared by the event tests: a fixed clock, one admin, and a two-stage team
 *  event (Swiss top 8, then single elimination) starting nine days later. */
export const NOW = new Date('2026-10-01T12:00:00.000Z');
export const START = '2026-10-10T20:00:00.000Z';
export const ADMIN = '76561199000000700';

export function cupId(db: DB): number {
  return (db.prepare("SELECT id FROM rulesets WHERE name = 'Standard Cup'").get() as { id: number }).id;
}

export function stageBody(db: DB, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'swiss', config: { rounds: 4 }, rulesetId: cupId(db), campaignPool: ['no_mercy', 'dead_air'], advanceCount: 8, ...over };
}

export function must<T>(r: E.EventResult<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.value;
}

export interface Fixture { db: DB; eventId: number; s1: number; s2: number }

export function eventFixture(status: 'draft' | 'announced' = 'draft'): Fixture {
  const db = openDb(':memory:');
  upsertPlayer(db, { steamid: ADMIN, name: 'boss', avatar: null }, []);
  const ev = must(E.createEvent(db, { by: ADMIN, fields: { name: 'Riverside Cup', startsAt: START, entryKind: 'team' }, now: NOW }));
  const s1 = must(E.addStage(db, { eventId: ev.id, by: ADMIN, stage: stageBody(db), now: NOW }));
  const s2 = must(E.addStage(db, {
    eventId: ev.id, by: ADMIN, stage: stageBody(db, { type: 'single_elim', config: { thirdPlace: true }, advanceCount: null }), now: NOW,
  }));
  if (status === 'announced') must(E.publishEvent(db, { eventId: ev.id, by: ADMIN, now: NOW }));
  return { db, eventId: ev.id, s1: s1.id, s2: s2.id };
}
```

- [ ] **Step 2: Write the failing behaviour tests**

`tests/events.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import * as E from '../src/events/events.js';
import { TEMPLATES, rulesForKind } from '../src/rulesets.js';
import { ADMIN, NOW, START, cupId, eventFixture, must, stageBody } from './eventFixture.js';

const err = (r: E.EventResult<unknown>) => (r.ok ? null : r.error);
const LATER = new Date('2026-10-11T00:00:00.000Z');
const actions = (f: { db: import('../src/db.js').DB; eventId: number }) => E.eventLog(f.db, f.eventId).map((l) => l.action);

describe('createEvent', () => {
  it('makes an official draft with a slug from the name, unique over every event and never a reserved word', () => {
    const f = eventFixture();
    const ev = E.getEvent(f.db, f.eventId)!;
    expect(ev).toMatchObject({ slug: 'riverside-cup', status: 'draft', official: 1, organizer_steamid: ADMIN, starts_at: START, team_cap: null });
    expect(E.fieldsOf(ev).checkin).toEqual({ enabled: true, opensMinutes: 60, closesMinutes: 15 });
    const again = must(E.createEvent(f.db, { by: ADMIN, fields: { name: 'riverside cup', startsAt: START, entryKind: 'team' }, now: NOW }));
    expect(again.slug).toBe('riverside-cup-2');
    const reserved = must(E.createEvent(f.db, { by: ADMIN, fields: { name: 'New', startsAt: START, entryKind: 'draft' }, now: NOW }));
    expect(reserved.slug).toBe('new-2');
    expect(E.eventLog(f.db, again.id).map((l) => [l.action, l.actor])).toEqual([['created', ADMIN]]);
  });

  it('refuses a start time that has passed, and writes nothing', () => {
    const f = eventFixture();
    const before = f.db.prepare('SELECT COUNT(*) AS n FROM events').get();
    expect(err(E.createEvent(f.db, { by: ADMIN, fields: { name: 'Late Cup', startsAt: START, entryKind: 'team' }, now: LATER }))).toBe('start_passed');
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual(before);
  });
});

describe('updateEvent', () => {
  it('edits fields, keeps the slug, and logs which fields changed', () => {
    const f = eventFixture();
    const ev = must(E.updateEvent(f.db, { eventId: f.eventId, by: ADMIN, fields: { name: 'Riverside Spring Cup', teamCap: 16 }, now: NOW }));
    expect(ev).toMatchObject({ name: 'Riverside Spring Cup', slug: 'riverside-cup', team_cap: 16 });
    const last = E.eventLog(f.db, f.eventId).at(-1)!;
    expect([last.action, JSON.parse(last.detail)]).toEqual(['edited', { changed: ['name', 'teamCap'] }]);
  });

  it('an edit that changes nothing writes nothing', () => {
    const f = eventFixture();
    const n = E.eventLog(f.db, f.eventId).length;
    expect(E.updateEvent(f.db, { eventId: f.eventId, by: ADMIN, fields: { name: 'Riverside Cup' }, now: NOW }).ok).toBe(true);
    expect(E.eventLog(f.db, f.eventId)).toHaveLength(n);
  });

  it('moves the start only into the future, and the entry kind only while a draft', () => {
    const f = eventFixture();
    expect(err(E.updateEvent(f.db, { eventId: f.eventId, by: ADMIN, fields: { startsAt: '2026-09-30T00:00:00.000Z' }, now: NOW }))).toBe('start_passed');
    must(E.publishEvent(f.db, { eventId: f.eventId, by: ADMIN, now: NOW }));
    expect(err(E.updateEvent(f.db, { eventId: f.eventId, by: ADMIN, fields: { entryKind: 'draft' }, now: NOW }))).toBe('kind_locked');
    expect(E.updateEvent(f.db, { eventId: f.eventId, by: ADMIN, fields: { description: 'Bring snacks.' }, now: NOW }).ok).toBe(true);
  });

  it('refuses edits once the event is past registration, and an unknown event', () => {
    const f = eventFixture();
    for (const status of ['checkin', 'live', 'finished', 'cancelled']) {
      f.db.prepare('UPDATE events SET status = ? WHERE id = ?').run(status, f.eventId);
      expect(err(E.updateEvent(f.db, { eventId: f.eventId, by: ADMIN, fields: { name: 'Other Cup' }, now: NOW }))).toBe('wrong_status');
    }
    expect(err(E.updateEvent(f.db, { eventId: 999, by: ADMIN, fields: { name: 'Other Cup' }, now: NOW }))).toBe('not_found');
  });
});

describe('stages', () => {
  it('numbers stages in order, and renumbers after a reorder and a remove', () => {
    const f = eventFixture();
    const s3 = must(E.addStage(f.db, { eventId: f.eventId, by: ADMIN, stage: stageBody(f.db, { advanceCount: 16 }), now: NOW }));
    expect(s3.ordinal).toBe(3);
    // Twice, so the rows' insertion order no longer matches their ordinals:
    // the unique (event_id, ordinal) index must never trip mid-renumber.
    must(E.reorderStages(f.db, { eventId: f.eventId, by: ADMIN, order: [s3.id, f.s2, f.s1], now: NOW }));
    must(E.reorderStages(f.db, { eventId: f.eventId, by: ADMIN, order: [s3.id, f.s1, f.s2], now: NOW }));
    must(E.removeStage(f.db, { eventId: f.eventId, stageId: s3.id, by: ADMIN, now: NOW }));
    expect(E.stagesOf(f.db, f.eventId).map((s) => [s.id, s.ordinal])).toEqual([[f.s1, 1], [f.s2, 2]]);
    expect(actions(f).slice(-3)).toEqual(['stages_reordered', 'stages_reordered', 'stage_removed']);
  });

  it('refuses an order that is not every stage once', () => {
    const f = eventFixture();
    for (const order of [[f.s1], [f.s1, f.s1], [f.s1, 999], 'x', [String(f.s1), String(f.s2)]]) {
      expect(err(E.reorderStages(f.db, { eventId: f.eventId, by: ADMIN, order, now: NOW }))).toBe('bad_order');
    }
  });

  it('holds an event to five stages, and a stage of another event is not found', () => {
    const f = eventFixture();
    for (let i = 0; i < 3; i++) must(E.addStage(f.db, { eventId: f.eventId, by: ADMIN, stage: stageBody(f.db), now: NOW }));
    expect(err(E.addStage(f.db, { eventId: f.eventId, by: ADMIN, stage: stageBody(f.db), now: NOW }))).toBe('too_many_stages');
    const other = must(E.createEvent(f.db, { by: ADMIN, fields: { name: 'Other Cup', startsAt: START, entryKind: 'team' }, now: NOW }));
    expect(err(E.updateStage(f.db, { eventId: other.id, stageId: f.s1, by: ADMIN, stage: stageBody(f.db), now: NOW }))).toBe('stage_not_found');
    expect(err(E.removeStage(f.db, { eventId: other.id, stageId: f.s1, by: ADMIN, now: NOW }))).toBe('stage_not_found');
  });

  it('takes the site pool when the form sends none, and refuses a bad stage with its own rule', () => {
    const f = eventFixture();
    const s = must(E.addStage(f.db, { eventId: f.eventId, by: ADMIN, stage: { type: 'swiss', rulesetId: cupId(f.db) }, now: NOW }));
    expect(E.stageSettingsOf(s).campaignPool).toEqual(['no_mercy', 'death_toll', 'dead_air', 'blood_harvest']);
    expect(err(E.addStage(f.db, { eventId: f.eventId, by: ADMIN, stage: stageBody(f.db, { vetoType: 'pick_ban' }), now: NOW }))).toBe('bad_pool_for_veto');
  });

  it('locks every stage change once the event is live', () => {
    const f = eventFixture();
    for (const status of ['live', 'finished', 'cancelled']) {
      f.db.prepare('UPDATE events SET status = ? WHERE id = ?').run(status, f.eventId);
      expect(err(E.addStage(f.db, { eventId: f.eventId, by: ADMIN, stage: stageBody(f.db), now: NOW }))).toBe('stages_locked');
      expect(err(E.updateStage(f.db, { eventId: f.eventId, stageId: f.s1, by: ADMIN, stage: stageBody(f.db), now: NOW }))).toBe('stages_locked');
      expect(err(E.removeStage(f.db, { eventId: f.eventId, stageId: f.s1, by: ADMIN, now: NOW }))).toBe('stages_locked');
      expect(err(E.reorderStages(f.db, { eventId: f.eventId, by: ADMIN, order: [f.s2, f.s1], now: NOW }))).toBe('stages_locked');
    }
  });
});

describe('publishEvent', () => {
  it('announces, snapshotting each stage ruleset as unrated tournament rules', () => {
    const f = eventFixture();
    expect(E.stagesOf(f.db, f.eventId).map((s) => s.rules_json)).toEqual([null, null]);
    expect(must(E.publishEvent(f.db, { eventId: f.eventId, by: ADMIN, now: NOW })).status).toBe('announced');
    const want = JSON.stringify(rulesForKind('tournament', TEMPLATES['Standard Cup']));
    expect(E.stagesOf(f.db, f.eventId).map((s) => s.rules_json)).toEqual([want, want]);
    expect(actions(f).at(-1)).toBe('published');
  });

  it('refuses without stages, with a broken chain, after the start, or twice', () => {
    const f = eventFixture();
    const bare = must(E.createEvent(f.db, { by: ADMIN, fields: { name: 'Bare Cup', startsAt: START, entryKind: 'team' }, now: NOW }));
    expect(err(E.publishEvent(f.db, { eventId: bare.id, by: ADMIN, now: NOW }))).toBe('no_stages');
    must(E.updateStage(f.db, { eventId: f.eventId, stageId: f.s2, by: ADMIN, stage: stageBody(f.db, { type: 'single_elim', config: {}, advanceCount: 4 }), now: NOW }));
    expect(err(E.publishEvent(f.db, { eventId: f.eventId, by: ADMIN, now: NOW }))).toBe('bad_chain');
    must(E.updateStage(f.db, { eventId: f.eventId, stageId: f.s2, by: ADMIN, stage: stageBody(f.db, { type: 'single_elim', config: {}, advanceCount: null }), now: NOW }));
    expect(err(E.publishEvent(f.db, { eventId: f.eventId, by: ADMIN, now: LATER }))).toBe('start_passed');
    must(E.publishEvent(f.db, { eventId: f.eventId, by: ADMIN, now: NOW }));
    expect(err(E.publishEvent(f.db, { eventId: f.eventId, by: ADMIN, now: NOW }))).toBe('wrong_status');
    expect(E.getEvent(f.db, f.eventId)!.status).toBe('announced');
  });

  it('re-checks stages against the lists of the moment: an archived ruleset, a campaign no longer poolable', () => {
    const f = eventFixture();
    f.db.prepare("UPDATE rulesets SET archived_at = '2026-10-01' WHERE id = ?").run(cupId(f.db));
    expect(err(E.publishEvent(f.db, { eventId: f.eventId, by: ADMIN, now: NOW }))).toBe('bad_ruleset');
    f.db.prepare('UPDATE rulesets SET archived_at = NULL WHERE id = ?').run(cupId(f.db));
    // dead_center needs the dlc4 pack: poolable while no server lacks it.
    must(E.updateStage(f.db, { eventId: f.eventId, stageId: f.s2, by: ADMIN, stage: stageBody(f.db, { type: 'single_elim', config: {}, advanceCount: null, campaignPool: ['dead_center'] }), now: NOW }));
    f.db.prepare("INSERT INTO servers (name, host, port, rcon_port, rcon_password, status) VALUES ('s1', 'h', 27015, 27015, 'pw', 'idle')").run();
    expect(err(E.publishEvent(f.db, { eventId: f.eventId, by: ADMIN, now: NOW }))).toBe('bad_pool');
    expect(E.getEvent(f.db, f.eventId)!.status).toBe('draft');
    expect(E.stagesOf(f.db, f.eventId).map((s) => s.rules_json)).toEqual([null, null]);
  });

  it('after publishing, a stage edit takes a fresh snapshot of its new ruleset', () => {
    const f = eventFixture('announced');
    const casual = (f.db.prepare("SELECT id FROM rulesets WHERE name = 'Casual Scrim'").get() as { id: number }).id;
    const s = must(E.updateStage(f.db, { eventId: f.eventId, stageId: f.s1, by: ADMIN, stage: stageBody(f.db, { rulesetId: casual }), now: NOW }));
    expect(s.rules_json).toBe(JSON.stringify(rulesForKind('tournament', TEMPLATES['Casual Scrim'])));
  });
});

describe('openRegistration', () => {
  it('opens a published team event, and nothing else', () => {
    const draft = eventFixture();
    expect(err(E.openRegistration(draft.db, { eventId: draft.eventId, by: ADMIN, now: NOW }))).toBe('wrong_status');
    const f = eventFixture('announced');
    expect(err(E.openRegistration(f.db, { eventId: f.eventId, by: ADMIN, now: LATER }))).toBe('start_passed');
    expect(must(E.openRegistration(f.db, { eventId: f.eventId, by: ADMIN, now: NOW })).status).toBe('registration');
    expect(actions(f).at(-1)).toBe('registration_opened');
  });

  it('refuses a draft-kind event: its signups belong to the drafts plan', () => {
    const f = eventFixture();
    must(E.updateEvent(f.db, { eventId: f.eventId, by: ADMIN, fields: { entryKind: 'draft' }, now: NOW }));
    must(E.publishEvent(f.db, { eventId: f.eventId, by: ADMIN, now: NOW }));
    expect(err(E.openRegistration(f.db, { eventId: f.eventId, by: ADMIN, now: NOW }))).toBe('draft_signups_later');
  });
});

describe('cancelEvent', () => {
  it('cancels from any open status with an optional reason, once', () => {
    const f = eventFixture('announced');
    const ev = must(E.cancelEvent(f.db, { eventId: f.eventId, by: ADMIN, reason: ' Not enough teams ', now: NOW }));
    expect(ev).toMatchObject({ status: 'cancelled', cancel_reason: 'Not enough teams', cancelled_at: NOW.toISOString() });
    expect(JSON.parse(E.eventLog(f.db, f.eventId).at(-1)!.detail)).toEqual({ from: 'announced', reason: 'Not enough teams' });
    expect(err(E.cancelEvent(f.db, { eventId: f.eventId, by: ADMIN, reason: null, now: NOW }))).toBe('wrong_status');
    const live = eventFixture();
    live.db.prepare("UPDATE events SET status = 'live' WHERE id = ?").run(live.eventId);
    expect(E.cancelEvent(live.db, { eventId: live.eventId, by: ADMIN, reason: undefined, now: NOW }).ok).toBe(true);
  });

  it('never cancels a finished event, and refuses an over-long reason', () => {
    const f = eventFixture();
    expect(err(E.cancelEvent(f.db, { eventId: f.eventId, by: ADMIN, reason: 'x'.repeat(301), now: NOW }))).toBe('bad_reason');
    f.db.prepare("UPDATE events SET status = 'finished' WHERE id = ?").run(f.eventId);
    expect(err(E.cancelEvent(f.db, { eventId: f.eventId, by: ADMIN, reason: null, now: NOW }))).toBe('wrong_status');
  });
});
```

- [ ] **Step 3: Write the failing guard tests**

`tests/eventLogGuard.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from '../src/events/events.js';
import { ADMIN, NOW, START, eventFixture, stageBody, type Fixture } from './eventFixture.js';

/**
 * Spec, Error handling: every event state change is one transaction with an
 * audit row. Three guards hold that:
 *  1. only src/events/events.ts writes events, event_stages or event_log;
 *  2. each exported mutation, on success, adds exactly one event_log row
 *     with its action, and when that row cannot be written nothing else is
 *     written either (an event_log trigger that always fails);
 *  3. every exported function of events.ts is either a known read or listed
 *     in MUTATIONS here, so a new mutation cannot skip guard 2.
 */

const WRITERS = /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+(?:events|event_stages|event_log)\b/g;
const READS = new Set(['getEvent', 'getEventBySlug', 'getStage', 'stagesOf', 'eventLog', 'fieldsOf', 'stageSettingsOf', 'stageContext']);

const MUTATIONS: Record<string, { from: 'draft' | 'announced'; action: string; run: (f: Fixture) => E.EventResult<unknown> }> = {
  createEvent: { from: 'draft', action: 'created', run: ({ db }) => E.createEvent(db, { by: ADMIN, fields: { name: 'Second Cup', startsAt: START, entryKind: 'team' }, now: NOW }) },
  updateEvent: { from: 'draft', action: 'edited', run: ({ db, eventId }) => E.updateEvent(db, { eventId, by: ADMIN, fields: { name: 'Renamed Cup' }, now: NOW }) },
  addStage: { from: 'draft', action: 'stage_added', run: ({ db, eventId }) => E.addStage(db, { eventId, by: ADMIN, stage: stageBody(db), now: NOW }) },
  updateStage: {
    from: 'draft', action: 'stage_edited',
    run: ({ db, eventId, s2 }) => E.updateStage(db, { eventId, stageId: s2, by: ADMIN, stage: stageBody(db, { type: 'double_elim', config: {}, advanceCount: null }), now: NOW }),
  },
  removeStage: { from: 'draft', action: 'stage_removed', run: ({ db, eventId, s2 }) => E.removeStage(db, { eventId, stageId: s2, by: ADMIN, now: NOW }) },
  reorderStages: { from: 'draft', action: 'stages_reordered', run: ({ db, eventId, s1, s2 }) => E.reorderStages(db, { eventId, by: ADMIN, order: [s2, s1], now: NOW }) },
  publishEvent: { from: 'draft', action: 'published', run: ({ db, eventId }) => E.publishEvent(db, { eventId, by: ADMIN, now: NOW }) },
  openRegistration: { from: 'announced', action: 'registration_opened', run: ({ db, eventId }) => E.openRegistration(db, { eventId, by: ADMIN, now: NOW }) },
  cancelEvent: { from: 'draft', action: 'cancelled', run: ({ db, eventId }) => E.cancelEvent(db, { eventId, by: ADMIN, reason: 'Not enough teams', now: NOW }) },
};

const logCount = (f: Fixture) => (f.db.prepare('SELECT COUNT(*) AS n FROM event_log').get() as { n: number }).n;
const snapshot = (f: Fixture) => JSON.stringify([
  f.db.prepare('SELECT * FROM events ORDER BY id').all(),
  f.db.prepare('SELECT * FROM event_stages ORDER BY id').all(),
]);

describe('event_log guard', () => {
  it('only src/events/events.ts writes the event tables', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const walk = (dir: string): string[] => readdirSync(join(root, dir), { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : e.name.endsWith('.ts') ? [`${dir}/${e.name}`] : []));
    const offenders = walk('src')
      .filter((f) => f !== 'src/events/events.ts')
      .filter((f) => (readFileSync(join(root, f), 'utf8').match(WRITERS) ?? []).length > 0);
    expect(offenders).toEqual([]);
  });

  it('every exported function of events.ts is a known read or a guarded mutation', () => {
    const fns = Object.entries(E).filter(([, v]) => typeof v === 'function').map(([k]) => k);
    expect(fns.filter((k) => !READS.has(k)).sort()).toEqual(Object.keys(MUTATIONS).sort());
  });

  for (const [name, m] of Object.entries(MUTATIONS)) {
    it(`${name} writes exactly one event_log row, ${m.action}`, () => {
      const f = eventFixture(m.from);
      const before = logCount(f);
      const r = m.run(f);
      expect(r.ok, r.ok ? '' : r.error).toBe(true);
      expect(logCount(f)).toBe(before + 1);
      expect(f.db.prepare('SELECT action, actor FROM event_log ORDER BY id DESC LIMIT 1').get()).toEqual({ action: m.action, actor: ADMIN });
    });

    it(`${name} writes nothing when its event_log row cannot be written`, () => {
      const f = eventFixture(m.from);
      const before = snapshot(f);
      const logs = logCount(f);
      f.db.exec("CREATE TRIGGER event_log_down BEFORE INSERT ON event_log BEGIN SELECT RAISE(ABORT, 'event_log down'); END");
      expect(() => m.run(f)).toThrow(/event_log down/);
      expect(snapshot(f)).toBe(before);
      expect(logCount(f)).toBe(logs);
    });
  }
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run tests/events.test.ts tests/eventLogGuard.test.ts`
Expected: FAIL with `Cannot find module '../src/events/events.js'`.

- [ ] **Step 5: Write `src/events/events.ts`**

```ts
import type { DB } from '../db.js';
import { getCampaignPool } from '../settings.js';
import { poolableCampaigns } from '../campaignRegistry.js';
import { parseRules, rulesForKind } from '../rulesets.js';
import * as V from './validate.js';

/**
 * Every write to events, event_stages and event_log (tournaments plan T1a).
 *
 * Each mutation is one better-sqlite3 transaction that re-reads the event,
 * checks its rules inside, writes, and adds its event_log row before it
 * commits. If the audit row cannot be written, nothing is: the insert throws
 * and the transaction rolls back (tests/eventLogGuard.test.ts pins this and
 * that nothing else in src/ writes these tables). A refusal returns before
 * any write, so it leaves no trace. Results are { ok, value } or
 * { ok: false, error } with error a key of V.EVENT_ERRORS, the same shape as
 * src/teams/teams.ts, so the routes map them to a status and a sentence.
 */

export interface EventRow {
  id: number; slug: string; name: string; banner_key: string | null; region: string; organizer_steamid: string;
  official: number; entry_kind: V.EntryKind; status: V.EventStatus; starts_at: string; description: string;
  eligibility_json: string; team_cap: number | null; checkin_json: string; roster_json: string;
  created_at: string; updated_at: string; finished_at: string | null; cancelled_at: string | null; cancel_reason: string | null;
}
export interface StageRow {
  id: number; event_id: number; ordinal: number; type: V.StageType; config_json: string; ruleset_id: number;
  rules_json: string | null; game_config: string; campaign_pool_json: string; veto_type: V.VetoType;
  chapters: number | null; scheduling: V.Scheduling; advance_count: number | null; status: 'pending' | 'live' | 'finished';
  created_at: string; updated_at: string;
}
export interface EventLogRow { id: number; event_id: number; at: string; actor: string | null; action: string; detail: string }
export type EventResult<T> = V.Checked<T>;

export function getEvent(db: DB, id: number): EventRow | undefined {
  return db.prepare('SELECT * FROM events WHERE id = ?').get(id) as EventRow | undefined;
}
export function getEventBySlug(db: DB, slug: string): EventRow | undefined {
  return db.prepare('SELECT * FROM events WHERE slug = ?').get(slug) as EventRow | undefined;
}
export function getStage(db: DB, id: number): StageRow | undefined {
  return db.prepare('SELECT * FROM event_stages WHERE id = ?').get(id) as StageRow | undefined;
}
export function stagesOf(db: DB, eventId: number): StageRow[] {
  return db.prepare('SELECT * FROM event_stages WHERE event_id = ? ORDER BY ordinal').all(eventId) as StageRow[];
}
export function eventLog(db: DB, eventId: number): EventLogRow[] {
  return db.prepare('SELECT * FROM event_log WHERE event_id = ? ORDER BY id').all(eventId) as EventLogRow[];
}

/** The JSON columns were written by this module from validated values. */
export function fieldsOf(ev: EventRow): V.EventFields {
  return {
    name: ev.name, startsAt: ev.starts_at, entryKind: ev.entry_kind, official: ev.official === 1, teamCap: ev.team_cap,
    description: ev.description,
    eligibility: JSON.parse(ev.eligibility_json) as V.Eligibility,
    checkin: JSON.parse(ev.checkin_json) as V.Checkin,
    roster: JSON.parse(ev.roster_json) as V.RosterRules,
  };
}

export function stageSettingsOf(s: StageRow): V.StageSettings {
  return {
    type: s.type, config: JSON.parse(s.config_json) as V.StageConfig, rulesetId: s.ruleset_id, gameConfig: s.game_config,
    campaignPool: JSON.parse(s.campaign_pool_json) as string[], vetoType: s.veto_type, chapters: s.chapters,
    scheduling: s.scheduling, advanceCount: s.advance_count,
  };
}

/** The lists a stage is checked against, read now (Ruling 20). */
export function stageContext(db: DB): V.StageContext {
  const campaigns = new Set(poolableCampaigns(db).map((c) => c.slug));
  return {
    campaigns,
    rulesetIds: new Set((db.prepare('SELECT id FROM rulesets WHERE archived_at IS NULL').all() as { id: number }[]).map((r) => r.id)),
    gameConfigs: new Set((db.prepare('SELECT key FROM game_configs WHERE enabled = 1').all() as { key: string }[]).map((r) => r.key)),
    defaultPool: getCampaignPool(db).filter((s) => campaigns.has(s)).slice(0, V.POOL_MAX),
  };
}

const iso = (now?: Date): string => (now ?? new Date()).toISOString();

/** Inside the caller's transaction, always. */
function logEvent(db: DB, eventId: number, actor: string | null, action: string, at: string, detail: object = {}): void {
  db.prepare('INSERT INTO event_log (event_id, at, actor, action, detail) VALUES (?, ?, ?, ?, ?)')
    .run(eventId, at, actor, action, JSON.stringify(detail));
}

function touch(db: DB, eventId: number, at: string): void {
  db.prepare('UPDATE events SET updated_at = ? WHERE id = ?').run(at, eventId);
}

/** Unique over every event ever made (Ruling 9), fixed at creation. */
function slugFor(db: DB, name: string): string {
  const base = V.eventSlugBase(name);
  const taken = db.prepare('SELECT 1 FROM events WHERE slug = ?');
  if (!V.RESERVED_EVENT_SLUGS.has(base) && !taken.get(base)) return base;
  for (let n = 2; ; n++) {
    const s = `${base}-${n}`;
    if (!taken.get(s)) return s;
  }
}

/** Ruling 7: the ruleset as a tournament plays it, or null if it is gone or unreadable. */
function rulesSnapshot(db: DB, rulesetId: number): string | null {
  const row = db.prepare('SELECT rules_json FROM rulesets WHERE id = ? AND archived_at IS NULL').get(rulesetId) as { rules_json: string } | undefined;
  if (!row) return null;
  try {
    return JSON.stringify(rulesForKind('tournament', parseRules(row.rules_json)));
  } catch {
    return null;
  }
}

/** Ordinals 1..n in the given order. Through negatives first, so the unique
 *  (event_id, ordinal) index never sees two stages on one number, whatever
 *  order SQLite visits the rows in. */
function renumber(db: DB, eventId: number, ids: number[]): void {
  db.prepare('UPDATE event_stages SET ordinal = -ordinal WHERE event_id = ?').run(eventId);
  const set = db.prepare('UPDATE event_stages SET ordinal = ? WHERE id = ?');
  ids.forEach((id, i) => set.run(i + 1, id));
}

function ownStage(db: DB, eventId: number, stageId: number): StageRow | undefined {
  const s = getStage(db, stageId);
  return s && s.event_id === eventId ? s : undefined;
}

function insertStage(db: DB, eventId: number, ordinal: number, s: V.StageSettings, rules: string | null, at: string): number {
  return Number(db.prepare(
    `INSERT INTO event_stages (event_id, ordinal, type, config_json, ruleset_id, rules_json, game_config, campaign_pool_json,
       veto_type, chapters, scheduling, advance_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(eventId, ordinal, s.type, JSON.stringify(s.config), s.rulesetId, rules, s.gameConfig, JSON.stringify(s.campaignPool),
    s.vetoType, s.chapters, s.scheduling, s.advanceCount, at, at).lastInsertRowid);
}

function writeStage(db: DB, id: number, s: V.StageSettings, rules: string | null, at: string): void {
  db.prepare(
    `UPDATE event_stages SET type = ?, config_json = ?, ruleset_id = ?, rules_json = ?, game_config = ?, campaign_pool_json = ?,
       veto_type = ?, chapters = ?, scheduling = ?, advance_count = ?, updated_at = ? WHERE id = ?`,
  ).run(s.type, JSON.stringify(s.config), s.rulesetId, rules, s.gameConfig, JSON.stringify(s.campaignPool),
    s.vetoType, s.chapters, s.scheduling, s.advanceCount, at, id);
}

/** The stage chain as it stands, for publish and open registration (Ruling 16). */
function chainOf(db: DB, ev: EventRow): V.Checked<null> {
  const f = fieldsOf(ev);
  return V.checkChain(stagesOf(db, ev.id).map((s) => ({ advanceCount: s.advance_count })), { teamCap: f.teamCap, roster: f.roster });
}

export function createEvent(db: DB, o: { by: string; fields: unknown; now?: Date }): EventResult<EventRow> {
  const at = iso(o.now);
  const parsed = V.parseEventFields(o.fields, null);
  if (!parsed.ok) return parsed;
  const f = parsed.value;
  if (f.startsAt <= at) return V.fail('start_passed');
  return db.transaction((): EventResult<EventRow> => {
    const id = Number(db.prepare(
      `INSERT INTO events (slug, name, organizer_steamid, official, entry_kind, starts_at, description,
         eligibility_json, team_cap, checkin_json, roster_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(slugFor(db, f.name), f.name, o.by, f.official ? 1 : 0, f.entryKind, f.startsAt, f.description,
      JSON.stringify(f.eligibility), f.teamCap, JSON.stringify(f.checkin), JSON.stringify(f.roster), at, at).lastInsertRowid);
    logEvent(db, id, o.by, 'created', at, { name: f.name, startsAt: f.startsAt, entryKind: f.entryKind });
    return V.ok(getEvent(db, id)!);
  })();
}

export function updateEvent(db: DB, o: { eventId: number; by: string; fields: unknown; now?: Date }): EventResult<EventRow> {
  const at = iso(o.now);
  return db.transaction((): EventResult<EventRow> => {
    const ev = getEvent(db, o.eventId);
    if (!ev) return V.fail('not_found');
    if (!V.EVENT_EDITABLE.has(ev.status)) return V.fail('wrong_status');
    const before = fieldsOf(ev);
    const parsed = V.parseEventFields(o.fields, before);
    if (!parsed.ok) return parsed;
    const f = parsed.value;
    if (f.entryKind !== before.entryKind && ev.status !== 'draft') return V.fail('kind_locked');
    if (f.startsAt !== before.startsAt && f.startsAt <= at) return V.fail('start_passed');
    const changed = (Object.keys(f) as (keyof V.EventFields)[]).filter((k) => JSON.stringify(f[k]) !== JSON.stringify(before[k]));
    if (changed.length === 0) return V.ok(ev);
    db.prepare(
      `UPDATE events SET name = ?, official = ?, entry_kind = ?, starts_at = ?, description = ?, eligibility_json = ?,
         team_cap = ?, checkin_json = ?, roster_json = ?, updated_at = ? WHERE id = ?`,
    ).run(f.name, f.official ? 1 : 0, f.entryKind, f.startsAt, f.description, JSON.stringify(f.eligibility),
      f.teamCap, JSON.stringify(f.checkin), JSON.stringify(f.roster), at, ev.id);
    logEvent(db, ev.id, o.by, 'edited', at, { changed });
    return V.ok(getEvent(db, ev.id)!);
  })();
}

export function addStage(db: DB, o: { eventId: number; by: string; stage: unknown; now?: Date }): EventResult<StageRow> {
  const at = iso(o.now);
  const ctx = stageContext(db);
  return db.transaction((): EventResult<StageRow> => {
    const ev = getEvent(db, o.eventId);
    if (!ev) return V.fail('not_found');
    if (V.STAGES_LOCKED.has(ev.status)) return V.fail('stages_locked');
    const count = stagesOf(db, ev.id).length;
    if (count >= V.STAGES_MAX) return V.fail('too_many_stages');
    const p = V.parseStage(o.stage, ctx);
    if (!p.ok) return p;
    const rules = ev.status === 'draft' ? null : rulesSnapshot(db, p.value.rulesetId);
    if (ev.status !== 'draft' && rules === null) return V.fail('bad_ruleset');
    const id = insertStage(db, ev.id, count + 1, p.value, rules, at);
    touch(db, ev.id, at);
    logEvent(db, ev.id, o.by, 'stage_added', at, { stageId: id, ordinal: count + 1, type: p.value.type });
    return V.ok(getStage(db, id)!);
  })();
}

export function updateStage(db: DB, o: { eventId: number; stageId: number; by: string; stage: unknown; now?: Date }): EventResult<StageRow> {
  const at = iso(o.now);
  const ctx = stageContext(db);
  return db.transaction((): EventResult<StageRow> => {
    const ev = getEvent(db, o.eventId);
    if (!ev) return V.fail('not_found');
    if (V.STAGES_LOCKED.has(ev.status)) return V.fail('stages_locked');
    const s = ownStage(db, ev.id, o.stageId);
    if (!s) return V.fail('stage_not_found');
    const p = V.parseStage(o.stage, ctx);
    if (!p.ok) return p;
    const rules = ev.status === 'draft' ? null : rulesSnapshot(db, p.value.rulesetId);
    if (ev.status !== 'draft' && rules === null) return V.fail('bad_ruleset');
    writeStage(db, s.id, p.value, rules, at);
    touch(db, ev.id, at);
    logEvent(db, ev.id, o.by, 'stage_edited', at, { stageId: s.id, ordinal: s.ordinal, type: p.value.type });
    return V.ok(getStage(db, s.id)!);
  })();
}

/** Ruling 18: a stage has nothing hanging off it yet, so it is deleted. */
export function removeStage(db: DB, o: { eventId: number; stageId: number; by: string; now?: Date }): EventResult<null> {
  const at = iso(o.now);
  return db.transaction((): EventResult<null> => {
    const ev = getEvent(db, o.eventId);
    if (!ev) return V.fail('not_found');
    if (V.STAGES_LOCKED.has(ev.status)) return V.fail('stages_locked');
    const s = ownStage(db, ev.id, o.stageId);
    if (!s) return V.fail('stage_not_found');
    db.prepare('DELETE FROM event_stages WHERE id = ?').run(s.id);
    renumber(db, ev.id, stagesOf(db, ev.id).map((x) => x.id));
    touch(db, ev.id, at);
    logEvent(db, ev.id, o.by, 'stage_removed', at, { stageId: s.id, ordinal: s.ordinal, type: s.type });
    return V.ok(null);
  })();
}

export function reorderStages(db: DB, o: { eventId: number; by: string; order: unknown; now?: Date }): EventResult<StageRow[]> {
  const at = iso(o.now);
  return db.transaction((): EventResult<StageRow[]> => {
    const ev = getEvent(db, o.eventId);
    if (!ev) return V.fail('not_found');
    if (V.STAGES_LOCKED.has(ev.status)) return V.fail('stages_locked');
    const ids = stagesOf(db, ev.id).map((s) => s.id);
    const order = o.order;
    if (!Array.isArray(order) || order.length !== ids.length || new Set(order).size !== ids.length
      || !order.every((x) => typeof x === 'number' && ids.includes(x))) {
      return V.fail('bad_order');
    }
    renumber(db, ev.id, order as number[]);
    touch(db, ev.id, at);
    logEvent(db, ev.id, o.by, 'stages_reordered', at, { order });
    return V.ok(stagesOf(db, ev.id));
  })();
}

/** draft -> announced. Every stage is checked again against the lists of
 *  this moment (Ruling 20) and its ruleset snapshotted (Ruling 7). */
export function publishEvent(db: DB, o: { eventId: number; by: string; now?: Date }): EventResult<EventRow> {
  const at = iso(o.now);
  const ctx = stageContext(db);
  return db.transaction((): EventResult<EventRow> => {
    const ev = getEvent(db, o.eventId);
    if (!ev) return V.fail('not_found');
    if (!V.nextStatusAllowed(ev.status, 'announced')) return V.fail('wrong_status');
    if (ev.starts_at <= at) return V.fail('start_passed');
    const chain = chainOf(db, ev);
    if (!chain.ok) return chain;
    const snapshots: [number, string][] = [];
    for (const s of stagesOf(db, ev.id)) {
      const p = V.parseStage(stageSettingsOf(s), ctx);
      if (!p.ok) return p;
      const rules = rulesSnapshot(db, s.ruleset_id);
      if (rules === null) return V.fail('bad_ruleset');
      snapshots.push([s.id, rules]);
    }
    const snap = db.prepare('UPDATE event_stages SET rules_json = ?, updated_at = ? WHERE id = ?');
    for (const [id, rules] of snapshots) snap.run(rules, at, id);
    db.prepare("UPDATE events SET status = 'announced', updated_at = ? WHERE id = ?").run(at, ev.id);
    logEvent(db, ev.id, o.by, 'published', at, { stages: snapshots.length });
    return V.ok(getEvent(db, ev.id)!);
  })();
}

/** announced -> registration, team events only (Ruling 15). */
export function openRegistration(db: DB, o: { eventId: number; by: string; now?: Date }): EventResult<EventRow> {
  const at = iso(o.now);
  return db.transaction((): EventResult<EventRow> => {
    const ev = getEvent(db, o.eventId);
    if (!ev) return V.fail('not_found');
    if (!V.nextStatusAllowed(ev.status, 'registration')) return V.fail('wrong_status');
    if (ev.entry_kind === 'draft') return V.fail('draft_signups_later');
    if (ev.starts_at <= at) return V.fail('start_passed');
    const chain = chainOf(db, ev);
    if (!chain.ok) return chain;
    db.prepare("UPDATE events SET status = 'registration', updated_at = ? WHERE id = ?").run(at, ev.id);
    logEvent(db, ev.id, o.by, 'registration_opened', at);
    return V.ok(getEvent(db, ev.id)!);
  })();
}

export function cancelEvent(db: DB, o: { eventId: number; by: string; reason: unknown; now?: Date }): EventResult<EventRow> {
  const at = iso(o.now);
  const reason = V.normalizeReason(o.reason);
  if (!reason.ok) return reason;
  return db.transaction((): EventResult<EventRow> => {
    const ev = getEvent(db, o.eventId);
    if (!ev) return V.fail('not_found');
    if (!V.nextStatusAllowed(ev.status, 'cancelled')) return V.fail('wrong_status');
    db.prepare("UPDATE events SET status = 'cancelled', cancelled_at = ?, cancel_reason = ?, updated_at = ? WHERE id = ?")
      .run(at, reason.value, at, ev.id);
    logEvent(db, ev.id, o.by, 'cancelled', at, { from: ev.status, reason: reason.value });
    return V.ok(getEvent(db, ev.id)!);
  })();
}
```

`f.startsAt <= at` compares two ISO UTC strings of the same `toISOString()` shape, which sort as times.

- [ ] **Step 6: Run the tests and typecheck**

Run: `npx vitest run tests/events.test.ts tests/eventLogGuard.test.ts tests/eventsValidate.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/events/events.ts tests/eventFixture.ts tests/events.test.ts tests/eventLogGuard.test.ts
git commit -m "Events: the event store, one transaction and one event_log row per change, with guard tests"
```

---

### Task 4: Admin routes for the Events desk

**Files:**
- Create: `src/routes/adminEvents.ts`
- Modify: `src/server.ts` (import next to `import { adminBookingRoutes } from './routes/adminBookings.js';`; register right after `await app.register(adminBookingRoutes, { db: deps.db, runner: bookingRunner });`)
- Test: `tests/adminEventRoutes.test.ts`

**Interfaces:**
- Consumes: Task 3 `E.*`; Task 2 `V.EVENT_ERRORS`, `V.defaultEligibility/defaultCheckin/defaultRoster`; `stageSummary` (Task 2 `format.ts`); `makeRequireAdmin(db)` and `makeRequireMod(db)` (`src/routes/guards.ts`); `logAdmin(db, adminId, action, target, detail)` (`src/admin/audit.ts`); `campaignRegistry(db)` (`src/campaignRegistry.ts`); `getPlayer(db, steamid)`.
- Produces (HTTP, whatever the switch; 401 signed out; every GET for staff, admin or mod, 403 for anyone else; every POST for an admin, 403 for anyone else, a mod included):
  - `GET /api/admin/events` -> `{ events: AdminEventRow[] }`, newest start first.
  - `GET /api/admin/events/options` -> `AdminEventOptions`.
  - `GET /api/admin/events/:id` -> `AdminEventDetail` (404 `{ error: 'No such event.' }`).
  - `POST /api/admin/events` body `{ name, startsAt, entryKind, ...optional EventFields }` -> `201 { id, slug }`.
  - `POST /api/admin/events/:id` (edit fields), `POST /api/admin/events/:id/stages` (add; body is a stage), `POST /api/admin/events/:id/stages/order` (`{ order: number[] }`), `POST /api/admin/events/:id/stages/:stageId` (edit), `POST /api/admin/events/:id/stages/:stageId/remove`, `POST /api/admin/events/:id/publish`, `POST /api/admin/events/:id/open-registration`, `POST /api/admin/events/:id/cancel` (`{ reason?: string }`) -> `{ ok: true }`; a refusal is `{ error: <EVENT_ERRORS text> }` with its status.
  - `logAdmin` actions: `event_create`, `event_edit`, `event_stage_add`, `event_stages_reorder`, `event_stage_edit`, `event_stage_remove`, `event_publish`, `event_open_registration`, `event_cancel`; target is the event id.
  - Types exported from `src/routes/adminEvents.ts`:
    - `interface AdminEventRow { id: number; slug: string; name: string; status: V.EventStatus; entryKind: V.EntryKind; startsAt: string; stages: number; updatedAt: string }`
    - `interface AdminEventStage { id: number; ordinal: number; summary: string; settings: V.StageSettings; rulesSnapshotted: boolean }`
    - `interface AdminEventDetail { id: number; slug: string; status: V.EventStatus; fields: V.EventFields; bannerKey: string | null; cancelReason: string | null; createdAt: string; updatedAt: string; stages: AdminEventStage[]; log: { at: string; actorName: string | null; action: string; detail: Record<string, unknown> }[] }`
    - `interface AdminEventOptions { campaigns: { slug: string; name: string }[]; defaultPool: string[]; rulesets: { id: number; name: string }[]; defaultRulesetId: number | null; gameConfigs: { key: string; label: string }[]; defaults: { eligibility: V.Eligibility; checkin: V.Checkin; roster: V.RosterRules } }`

- [ ] **Step 1: Write the failing tests**

`tests/adminEventRoutes.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import { EVENT_ERRORS } from '../src/events/validate.js';

const ADMIN = '76561199000000710';
const MOD = '76561199000000711';
const PLAYER = '76561199000000712';

let db: DB;
let app: FastifyInstance;
let cookies: Record<string, Record<string, string>>;
const start = () => new Date(Date.now() + 7 * 86_400_000).toISOString();

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({
    config: { ...loadConfig({}), communityDir: mkdtempSync(join(tmpdir(), 'adminevents-')) },
    db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {},
  });
  cookies = {};
  for (const id of [ADMIN, MOD, PLAYER]) cookies[id] = authedCookie(app, db, id);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
});
afterEach(async () => { await app.close(); });

const call = (method: 'GET' | 'POST', url: string, as?: string, payload?: object) =>
  app.inject({ method, url, cookies: as ? cookies[as] : undefined, payload });
const cup = () => (db.prepare("SELECT id FROM rulesets WHERE name = 'Standard Cup'").get() as { id: number }).id;

describe('the Events desk routes', () => {
  it('are read by staff and written by admins only, whatever the competitive switch says', async () => {
    expect((db.prepare("SELECT value FROM settings WHERE key = 'competitive_enabled'").get() as { value: string }).value).toBe('off');
    expect((await call('GET', '/api/admin/events', ADMIN)).statusCode).toBe(200);
    expect((await call('GET', '/api/admin/events', MOD)).statusCode).toBe(200);
    expect((await call('GET', '/api/admin/events', PLAYER)).statusCode).toBe(403);
    expect((await call('GET', '/api/admin/events')).statusCode).toBe(401);
    expect((await call('POST', '/api/admin/events', MOD, { name: 'Cup', startsAt: start(), entryKind: 'team' })).statusCode).toBe(403);
    expect(db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 0 });
  });

  it('a mod reads an event, its stages and its history, and every write answers 403', async () => {
    const { id } = (await call('POST', '/api/admin/events', ADMIN, { name: 'Riverside Cup', startsAt: start(), entryKind: 'team' })).json();
    await call('POST', `/api/admin/events/${id}/stages`, ADMIN, { type: 'single_elim', rulesetId: cup() });
    const seen = await call('GET', `/api/admin/events/${id}`, MOD);
    expect(seen.statusCode).toBe(200);
    expect(seen.json().stages).toHaveLength(1);
    expect(seen.json().log.map((l: { action: string }) => l.action)).toEqual(['created', 'stage_added']);
    expect((await call('GET', '/api/admin/events/options', MOD)).statusCode).toBe(200);
    const stageId = seen.json().stages[0].id;
    for (const [url, body] of [
      [`/api/admin/events/${id}`, { name: 'Mod Cup' }], [`/api/admin/events/${id}/stages`, { type: 'swiss', rulesetId: cup() }],
      [`/api/admin/events/${id}/stages/order`, { order: [stageId] }], [`/api/admin/events/${id}/stages/${stageId}`, { type: 'swiss', rulesetId: cup() }],
      [`/api/admin/events/${id}/stages/${stageId}/remove`, {}], [`/api/admin/events/${id}/publish`, {}],
      [`/api/admin/events/${id}/open-registration`, {}], [`/api/admin/events/${id}/cancel`, {}],
    ] as [string, object][]) {
      expect((await call('POST', url, MOD, body)).statusCode, url).toBe(403);
    }
    expect((await call('GET', `/api/admin/events/${id}`, ADMIN)).json().log).toHaveLength(2);
  });

  it('offers the poolable campaigns, the site pool, live rulesets with Standard Cup first choice, and the defaults', async () => {
    const r = await call('GET', '/api/admin/events/options', ADMIN);
    expect(r.statusCode).toBe(200);
    const o = r.json();
    expect(o.campaigns).toContainEqual({ slug: 'no_mercy', name: 'No Mercy' });
    expect(o.defaultPool).toEqual(['no_mercy', 'death_toll', 'dead_air', 'blood_harvest']);
    expect(o.rulesets.map((x: { name: string }) => x.name)).toEqual(['PUG', 'Standard Cup', 'Casual Scrim']);
    expect(o.defaultRulesetId).toBe(cup());
    expect(o.gameConfigs.map((g: { key: string }) => g.key)).toContain('standard');
    expect(o.defaults.checkin).toEqual({ enabled: true, opensMinutes: 60, closesMinutes: 15 });
  });

  it('runs create, edit, stages, publish, open registration and cancel, each audited twice', async () => {
    const created = await call('POST', '/api/admin/events', ADMIN, { name: 'Riverside Cup', startsAt: start(), entryKind: 'team' });
    expect(created.statusCode).toBe(201);
    const { id, slug } = created.json();
    expect(slug).toBe('riverside-cup');
    const ok = async (url: string, payload?: object) => {
      const r = await call('POST', url, ADMIN, payload);
      expect(r.statusCode, `${url} ${r.body}`).toBe(200);
    };
    await ok(`/api/admin/events/${id}`, { teamCap: 16, description: 'One night.\nBe on time.' });
    await ok(`/api/admin/events/${id}/stages`, { type: 'swiss', config: { rounds: 4 }, rulesetId: cup(), advanceCount: 8 });
    await ok(`/api/admin/events/${id}/stages`, { type: 'single_elim', config: { thirdPlace: false }, rulesetId: cup() });
    const stages = (await call('GET', `/api/admin/events/${id}`, ADMIN)).json().stages as { id: number }[];
    await ok(`/api/admin/events/${id}/stages/order`, { order: [stages[1].id, stages[0].id] });
    await ok(`/api/admin/events/${id}/stages/order`, { order: [stages[0].id, stages[1].id] });
    await ok(`/api/admin/events/${id}/stages/${stages[1].id}`, { type: 'single_elim', config: { thirdPlace: true }, rulesetId: cup() });
    await ok(`/api/admin/events/${id}/publish`);
    await ok(`/api/admin/events/${id}/open-registration`);
    await ok(`/api/admin/events/${id}/cancel`, { reason: 'Testing' });

    const detail = (await call('GET', `/api/admin/events/${id}`, ADMIN)).json();
    expect(detail).toMatchObject({ id, slug, status: 'cancelled', cancelReason: 'Testing' });
    expect(detail.fields.description).toBe('One night.\nBe on time.');
    expect(detail.stages.map((s: { summary: string; rulesSnapshotted: boolean }) => [s.summary, s.rulesSnapshotted]))
      .toEqual([['Swiss, 4 rounds, top 8 advance', true], ['Single elimination, third-place match', true]]);
    expect(detail.log.map((l: { action: string }) => l.action)).toEqual([
      'created', 'edited', 'stage_added', 'stage_added', 'stages_reordered', 'stages_reordered', 'stage_edited',
      'published', 'registration_opened', 'cancelled',
    ]);
    expect(detail.log[0].actorName).toBe(`p${ADMIN.slice(-3)}`);
    const audited = (db.prepare("SELECT action FROM admin_actions WHERE action LIKE 'event_%' ORDER BY id").all() as { action: string }[]).map((a) => a.action);
    expect(audited).toEqual([
      'event_create', 'event_edit', 'event_stage_add', 'event_stage_add', 'event_stages_reorder', 'event_stages_reorder',
      'event_stage_edit', 'event_publish', 'event_open_registration', 'event_cancel',
    ]);
  });

  it('answers a refusal with its rule sentence and status, and audits nothing for it', async () => {
    const past = await call('POST', '/api/admin/events', ADMIN, { name: 'Late Cup', startsAt: '2020-01-01T00:00:00.000Z', entryKind: 'team' });
    expect([past.statusCode, past.json()]).toEqual([EVENT_ERRORS.start_passed.status, { error: EVENT_ERRORS.start_passed.text }]);
    const { id } = (await call('POST', '/api/admin/events', ADMIN, { name: 'Bare Cup', startsAt: start(), entryKind: 'team' })).json();
    const bare = await call('POST', `/api/admin/events/${id}/publish`, ADMIN);
    expect([bare.statusCode, bare.json()]).toEqual([EVENT_ERRORS.no_stages.status, { error: EVENT_ERRORS.no_stages.text }]);
    expect((await call('GET', '/api/admin/events/999', ADMIN)).statusCode).toBe(404);
    expect((await call('GET', '/api/admin/events/abc', ADMIN)).statusCode).toBe(404);
    expect((await call('POST', `/api/admin/events/${id}/stages/abc`, ADMIN, {})).statusCode).toBe(404);
    expect(db.prepare("SELECT COUNT(*) AS n FROM admin_actions WHERE action = 'event_publish'").get()).toEqual({ n: 0 });
  });

  it('lists every event, drafts included, newest start first', async () => {
    await call('POST', '/api/admin/events', ADMIN, { name: 'First Cup', startsAt: start(), entryKind: 'team' });
    await call('POST', '/api/admin/events', ADMIN, { name: 'Later Cup', startsAt: new Date(Date.now() + 9 * 86_400_000).toISOString(), entryKind: 'draft' });
    const list = (await call('GET', '/api/admin/events', ADMIN)).json().events;
    expect(list.map((e: { name: string; status: string; stages: number }) => [e.name, e.status, e.stages]))
      .toEqual([['Later Cup', 'draft', 0], ['First Cup', 'draft', 0]]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/adminEventRoutes.test.ts`
Expected: FAIL, every route answers 404 (not registered).

- [ ] **Step 3: Write `src/routes/adminEvents.ts`**

```ts
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { DB } from '../db.js';
import { makeRequireAdmin, makeRequireMod } from './guards.js';
import { logAdmin } from '../admin/audit.js';
import { getPlayer } from '../players.js';
import { campaignRegistry } from '../campaignRegistry.js';
import * as E from '../events/events.js';
import * as V from '../events/validate.js';
import { stageSummary } from '../events/format.js';

export interface AdminEventRow {
  id: number; slug: string; name: string; status: V.EventStatus; entryKind: V.EntryKind; startsAt: string; stages: number; updatedAt: string;
}
export interface AdminEventStage { id: number; ordinal: number; summary: string; settings: V.StageSettings; rulesSnapshotted: boolean }
export interface AdminEventDetail {
  id: number; slug: string; status: V.EventStatus; fields: V.EventFields; bannerKey: string | null;
  cancelReason: string | null; createdAt: string; updatedAt: string;
  stages: AdminEventStage[];
  log: { at: string; actorName: string | null; action: string; detail: Record<string, unknown> }[];
}
export interface AdminEventOptions {
  campaigns: { slug: string; name: string }[]; defaultPool: string[];
  rulesets: { id: number; name: string }[]; defaultRulesetId: number | null;
  gameConfigs: { key: string; label: string }[];
  defaults: { eligibility: V.Eligibility; checkin: V.Checkin; roster: V.RosterRules };
}

export function adminEventDetail(db: DB, ev: E.EventRow): AdminEventDetail {
  return {
    id: ev.id, slug: ev.slug, status: ev.status, fields: E.fieldsOf(ev), bannerKey: ev.banner_key, cancelReason: ev.cancel_reason,
    createdAt: ev.created_at, updatedAt: ev.updated_at,
    stages: E.stagesOf(db, ev.id).map((s) => {
      const settings = E.stageSettingsOf(s);
      return { id: s.id, ordinal: s.ordinal, summary: stageSummary(settings.type, settings.config, settings.advanceCount), settings, rulesSnapshotted: s.rules_json !== null };
    }),
    log: E.eventLog(db, ev.id).map((l) => ({
      at: l.at, actorName: l.actor ? getPlayer(db, l.actor)?.name ?? l.actor : null, action: l.action,
      detail: JSON.parse(l.detail) as Record<string, unknown>,
    })),
  };
}

/**
 * The Events desk (tournaments plan T1a). Staff read it, admins write it
 * (Ruling 2): every GET takes an admin or a mod, every POST an admin only, so
 * a mod gets a 403 on any write. Not behind competitive_enabled (Ruling 13),
 * so events can be prepared while the switch is off. Every rule lives in
 * src/events/events.ts; a route maps the refusal to its status and sentence,
 * and on success adds logAdmin (Ruling 10) after the event's own transaction
 * has committed its event_log row.
 */
export async function adminEventRoutes(app: FastifyInstance, opts: { db: DB }): Promise<void> {
  const { db } = opts;
  const requireAdmin = makeRequireAdmin(db);
  const requireStaff = makeRequireMod(db);
  const refuse = (reply: FastifyReply, error: V.EventError) =>
    reply.code(V.EVENT_ERRORS[error].status).send({ error: V.EVENT_ERRORS[error].text });
  const idOf = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
  };

  app.get('/api/admin/events', async (req, reply) => {
    if (!requireStaff(req, reply)) return;
    const rows = db.prepare(
      `SELECT e.*, (SELECT COUNT(*) FROM event_stages s WHERE s.event_id = e.id) AS stage_count
       FROM events e ORDER BY e.starts_at DESC, e.id DESC`,
    ).all() as (E.EventRow & { stage_count: number })[];
    const events: AdminEventRow[] = rows.map((e) => ({
      id: e.id, slug: e.slug, name: e.name, status: e.status, entryKind: e.entry_kind, startsAt: e.starts_at, stages: e.stage_count, updatedAt: e.updated_at,
    }));
    return { events };
  });

  app.get('/api/admin/events/options', async (req, reply) => {
    if (!requireStaff(req, reply)) return;
    const ctx = E.stageContext(db);
    const registry = campaignRegistry(db);
    const rulesets = db.prepare('SELECT id, name FROM rulesets WHERE archived_at IS NULL ORDER BY id').all() as { id: number; name: string }[];
    const cup = rulesets.find((r) => r.name === 'Standard Cup');
    const options: AdminEventOptions = {
      campaigns: [...ctx.campaigns].map((slug) => ({ slug, name: registry.get(slug)?.name ?? slug })),
      defaultPool: ctx.defaultPool,
      rulesets,
      defaultRulesetId: cup?.id ?? rulesets[0]?.id ?? null,
      gameConfigs: db.prepare('SELECT key, label FROM game_configs WHERE enabled = 1 ORDER BY key').all() as { key: string; label: string }[],
      defaults: { eligibility: V.defaultEligibility(), checkin: V.defaultCheckin(), roster: V.defaultRoster() },
    };
    return options;
  });

  app.get('/api/admin/events/:id', async (req, reply) => {
    if (!requireStaff(req, reply)) return;
    const id = idOf((req.params as { id: string }).id);
    const ev = id === null ? undefined : E.getEvent(db, id);
    if (!ev) return refuse(reply, 'not_found');
    return adminEventDetail(db, ev);
  });

  app.post('/api/admin/events', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const r = E.createEvent(db, { by: me, fields: req.body ?? {} });
    if (!r.ok) return refuse(reply, r.error);
    logAdmin(db, me, 'event_create', r.value.id, { slug: r.value.slug, name: r.value.name });
    return reply.code(201).send({ id: r.value.id, slug: r.value.slug });
  });

  type Body = Record<string, unknown>;
  /** One admin action on one event (and maybe one of its stages): call the
   *  store, refuse or audit, answer { ok: true }. */
  const action = (
    path: string,
    name: string,
    call: (me: string, id: number, body: Body, stageId: number | null) => V.Checked<unknown>,
    detail: (body: Body, stageId: number | null) => object = () => ({}),
  ) => {
    app.post(path, async (req, reply) => {
      const me = requireAdmin(req, reply);
      if (!me) return;
      const p = req.params as { id: string; stageId?: string };
      const id = idOf(p.id);
      if (id === null) return refuse(reply, 'not_found');
      const stageId = p.stageId === undefined ? null : idOf(p.stageId);
      if (p.stageId !== undefined && stageId === null) return refuse(reply, 'stage_not_found');
      const body = (req.body ?? {}) as Body;
      const r = call(me, id, body, stageId);
      if (!r.ok) return refuse(reply, r.error);
      logAdmin(db, me, name, id, detail(body, stageId));
      return { ok: true };
    });
  };

  action('/api/admin/events/:id', 'event_edit',
    (me, id, body) => E.updateEvent(db, { eventId: id, by: me, fields: body }),
    (body) => ({ fields: Object.keys(body) }));
  action('/api/admin/events/:id/stages', 'event_stage_add',
    (me, id, body) => E.addStage(db, { eventId: id, by: me, stage: body }),
    (body) => ({ type: body.type }));
  action('/api/admin/events/:id/stages/order', 'event_stages_reorder',
    (me, id, body) => E.reorderStages(db, { eventId: id, by: me, order: body.order }),
    (body) => ({ order: body.order }));
  action('/api/admin/events/:id/stages/:stageId', 'event_stage_edit',
    (me, id, body, stageId) => E.updateStage(db, { eventId: id, stageId: stageId!, by: me, stage: body }),
    (_body, stageId) => ({ stageId }));
  action('/api/admin/events/:id/stages/:stageId/remove', 'event_stage_remove',
    (me, id, _body, stageId) => E.removeStage(db, { eventId: id, stageId: stageId!, by: me }),
    (_body, stageId) => ({ stageId }));
  action('/api/admin/events/:id/publish', 'event_publish',
    (me, id) => E.publishEvent(db, { eventId: id, by: me }));
  action('/api/admin/events/:id/open-registration', 'event_open_registration',
    (me, id) => E.openRegistration(db, { eventId: id, by: me }));
  action('/api/admin/events/:id/cancel', 'event_cancel',
    (me, id, body) => E.cancelEvent(db, { eventId: id, by: me, reason: body.reason }),
    (body) => ({ reason: typeof body.reason === 'string' ? body.reason.slice(0, V.CANCEL_REASON_MAX) : null }));
}
```

- [ ] **Step 4: Register the routes**

In `src/server.ts`, next to `import { adminBookingRoutes } from './routes/adminBookings.js';`:

```ts
import { adminEventRoutes } from './routes/adminEvents.js';
```

Right after `await app.register(adminBookingRoutes, { db: deps.db, runner: bookingRunner });`:

```ts
  // The Events desk (tournaments plan T1a): staff read, admins write, not behind the switch.
  await app.register(adminEventRoutes, { db: deps.db });
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `npx vitest run tests/adminEventRoutes.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/routes/adminEvents.ts src/server.ts tests/adminEventRoutes.test.ts
git commit -m "Events: desk routes, staff read and admins write, every write audited"
```

---

### Task 5: Public read routes and the event page view

**Files:**
- Create: `src/events/views.ts`
- Create: `src/routes/events.ts`
- Modify: `src/server.ts` (import next to `import { teamRoutes } from './routes/teams.js';`; register right after the `await app.register(teamRoutes, { ... });` block)
- Test: `tests/eventRoutes.test.ts`

**Interfaces:**
- Consumes: Task 3 `E.getEvent`, `E.getEventBySlug`, `E.stagesOf`, `E.fieldsOf`, `E.stageSettingsOf`; Task 2 `stageSummary`, `chaptersLabel`, `rulesLines`, `STAGE_LABEL`, `VETO_LABEL`; `parseRules`, `rulesForKind`; `campaignDisplayName(db, slug)`; `competitiveAccess(db, viewer)`, `competitivePublic(db)` (`src/teams/access.ts`); `makeOptionalViewer(db)`.
- Produces (`src/events/views.ts`):
  - `interface EventListItem { slug: string; name: string; status: V.EventStatus; entryKind: V.EntryKind; official: boolean; startsAt: string; bannerKey: string | null; format: string[]; entries: number }`
  - `interface EventStageView { ordinal: number; type: V.StageType; summary: string; veto: string; chapters: string; scheduling: V.Scheduling; rulesetName: string | null; rules: string[]; gameConfig: string; campaigns: { slug: string; name: string }[] }`
  - `interface EventEntryView { name: string; tag: string; seed: number | null; status: string }`
  - `interface EventView { slug: string; name: string; status: V.EventStatus; entryKind: V.EntryKind; official: boolean; organizerName: string | null; bannerKey: string | null; startsAt: string; description: string; teamCap: number | null; eligibility: V.Eligibility; checkin: V.Checkin; roster: V.RosterRules; stages: EventStageView[]; entries: EventEntryView[]; finishedAt: string | null; cancelledAt: string | null; cancelReason: string | null }`
  - `eventListItems(db, o: { staff: boolean }): EventListItem[]` (open events by start ascending, then finished and cancelled by start descending; drafts only when `staff`)
  - `eventView(db, ev: E.EventRow): EventView`
- Produces (HTTP): `GET /api/events` -> `{ events: EventListItem[] }`; `GET /api/events/:slug` -> `EventView`. Both 404 `{ error: 'not found' }` when the switch keeps the viewer out; the slug route also 404s (same body) for a draft unless the viewer is staff (admin or mod). `bannerKey` is read straight from `events.banner_key`; Task 6 adds the upload and the file route.

- [ ] **Step 1: Write the failing tests**

`tests/eventRoutes.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import * as E from '../src/events/events.js';
import { must } from './eventFixture.js';

const ADMIN = '76561199000000720';
const MOD = '76561199000000721';
const PLAYER = '76561199000000722';

let db: DB;
let app: FastifyInstance;
let cookies: Record<string, Record<string, string>>;
const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
const cup = () => (db.prepare("SELECT id FROM rulesets WHERE name = 'Standard Cup'").get() as { id: number }).id;

/** An event with a Swiss stage and a single elimination final, at `status`. */
function event(name: string, startsAt: string, status: 'draft' | 'announced' | 'registration' = 'announced', fields: object = {}): E.EventRow {
  const ev = must(E.createEvent(db, { by: ADMIN, fields: { name, startsAt, entryKind: 'team', ...fields } }));
  must(E.addStage(db, { eventId: ev.id, by: ADMIN, stage: { type: 'swiss', config: { rounds: 4 }, rulesetId: cup(), campaignPool: ['no_mercy', 'dead_air'], advanceCount: 8 } }));
  must(E.addStage(db, { eventId: ev.id, by: ADMIN, stage: { type: 'single_elim', config: { thirdPlace: true }, rulesetId: cup(), campaignPool: ['dead_air'], chapters: 3 } }));
  if (status !== 'draft') must(E.publishEvent(db, { eventId: ev.id, by: ADMIN }));
  if (status === 'registration') must(E.openRegistration(db, { eventId: ev.id, by: ADMIN }));
  return E.getEvent(db, ev.id)!;
}

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({
    config: { ...loadConfig({}), communityDir: mkdtempSync(join(tmpdir(), 'events-')) },
    db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {},
  });
  cookies = {};
  for (const id of [ADMIN, MOD, PLAYER]) cookies[id] = authedCookie(app, db, id);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
  db.prepare("UPDATE players SET name = 'Organizer' WHERE steamid = ?").run(ADMIN);
  db.prepare("UPDATE settings SET value = 'everyone' WHERE key = 'competitive_enabled'").run();
});
afterEach(async () => { await app.close(); });

const get = (url: string, as?: string) => app.inject({ method: 'GET', url, cookies: as ? cookies[as] : undefined });

describe('GET /api/events', () => {
  it('lists open events soonest first, then past ones newest first, with their format', async () => {
    event('Later Cup', days(9));
    event('Soon Cup', days(2), 'registration');
    const old = event('Old Cup', days(3));
    const older = event('Older Cup', days(4));
    for (const e of [old, older]) must(E.cancelEvent(db, { eventId: e.id, by: ADMIN, reason: null }));
    const list = (await get('/api/events', PLAYER)).json().events;
    expect(list.map((e: { name: string; status: string }) => [e.name, e.status])).toEqual([
      ['Soon Cup', 'registration'], ['Later Cup', 'announced'], ['Older Cup', 'cancelled'], ['Old Cup', 'cancelled'],
    ]);
    expect(list[0]).toMatchObject({ slug: 'soon-cup', entryKind: 'team', official: true, format: ['Swiss', 'Single elimination'], entries: 0 });
  });

  it('leaves drafts out for everyone but staff', async () => {
    event('Secret Cup', days(5), 'draft');
    event('Open Cup', days(6));
    for (const who of [undefined, PLAYER]) {
      expect((await get('/api/events', who)).json().events.map((e: { name: string }) => e.name)).toEqual(['Open Cup']);
    }
    for (const who of [ADMIN, MOD]) {
      expect((await get('/api/events', who)).json().events.map((e: { name: string }) => e.name)).toEqual(['Secret Cup', 'Open Cup']);
    }
  });
});

describe('GET /api/events/:slug', () => {
  it('serves the page: status, start, format strip, rules, pools, entry rules, no entries yet', async () => {
    const ev = event('Riverside Cup', days(5), 'announced', { description: 'Line one\n<b>two</b>', teamCap: 16 });
    const r = await get(`/api/events/${ev.slug}`, PLAYER);
    expect(r.statusCode).toBe(200);
    const v = r.json();
    expect(v).toMatchObject({
      slug: 'riverside-cup', name: 'Riverside Cup', status: 'announced', entryKind: 'team', official: true, organizerName: 'Organizer',
      startsAt: ev.starts_at, description: 'Line one\n<b>two</b>', teamCap: 16, entries: [], cancelReason: null, bannerKey: null,
      checkin: { enabled: true, opensMinutes: 60, closesMinutes: 15 },
    });
    expect(v.stages.map((s: { summary: string }) => s.summary)).toEqual(['Swiss, 4 rounds, top 8 advance', 'Single elimination, third-place match']);
    expect(v.stages[1]).toMatchObject({
      ordinal: 2, type: 'single_elim', veto: 'Ban to one (Bo1)', chapters: '3 chapters', scheduling: 'rolling',
      rulesetName: 'Standard Cup', gameConfig: expect.any(String), campaigns: [{ slug: 'dead_air', name: 'Dead Air' }],
    });
    expect(v.stages[0].rules).toContain('No-show grace: 15 minutes');
    expect(r.body.includes(ADMIN)).toBe(false);
  });

  it('a draft is the same 404 as an unknown slug to everyone but staff', async () => {
    const draft = event('Secret Cup', days(5), 'draft');
    const unknown = await get('/api/events/no-such-cup', PLAYER);
    expect(unknown.statusCode).toBe(404);
    for (const who of [undefined, PLAYER]) {
      const r = await get(`/api/events/${draft.slug}`, who);
      expect([r.statusCode, r.body]).toEqual([404, unknown.body]);
    }
    expect((await get(`/api/events/${draft.slug}`, MOD)).statusCode).toBe(200);
    const mine = await get(`/api/events/${draft.slug}`, ADMIN);
    expect(mine.statusCode).toBe(200);
    // A draft has no snapshot yet: its rules are read from the chosen ruleset.
    expect(mine.json().stages[0].rules).toContain('Higher seed picks sides');
  });

  it('shows a cancelled event with its reason', async () => {
    const ev = event('Gone Cup', days(5));
    must(E.cancelEvent(db, { eventId: ev.id, by: ADMIN, reason: 'Not enough teams' }));
    expect((await get(`/api/events/${ev.slug}`)).json()).toMatchObject({ status: 'cancelled', cancelReason: 'Not enough teams' });
  });

  it('follows the switch: admins only hides it from players and visitors', async () => {
    const ev = event('Riverside Cup', days(5));
    db.prepare("UPDATE settings SET value = 'admins' WHERE key = 'competitive_enabled'").run();
    expect((await get(`/api/events/${ev.slug}`, PLAYER)).statusCode).toBe(404);
    expect((await get(`/api/events/${ev.slug}`)).statusCode).toBe(404);
    expect((await get(`/api/events/${ev.slug}`, ADMIN)).statusCode).toBe(200);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/eventRoutes.test.ts`
Expected: FAIL, `/api/events` answers 404 for everyone (not registered).

- [ ] **Step 3: Write `src/events/views.ts`**

```ts
import type { DB } from '../db.js';
import { getPlayer } from '../players.js';
import { campaignDisplayName } from '../campaignRegistry.js';
import { parseRules, rulesForKind, type MatchRules } from '../rulesets.js';
import * as E from './events.js';
import type * as V from './validate.js';
import { STAGE_LABEL, VETO_LABEL, chaptersLabel, rulesLines, stageSummary } from './format.js';

/** What the public event list and event page show (spec section 7). */

export interface EventListItem {
  slug: string; name: string; status: V.EventStatus; entryKind: V.EntryKind; official: boolean; startsAt: string; bannerKey: string | null;
  format: string[]; entries: number;
}
export interface EventStageView {
  ordinal: number; type: V.StageType; summary: string; veto: string; chapters: string; scheduling: V.Scheduling;
  rulesetName: string | null; rules: string[]; gameConfig: string; campaigns: { slug: string; name: string }[];
}
export interface EventEntryView { name: string; tag: string; seed: number | null; status: string }
export interface EventView {
  slug: string; name: string; status: V.EventStatus; entryKind: V.EntryKind; official: boolean; organizerName: string | null;
  bannerKey: string | null; startsAt: string; description: string; teamCap: number | null;
  eligibility: V.Eligibility; checkin: V.Checkin; roster: V.RosterRules;
  stages: EventStageView[]; entries: EventEntryView[];
  finishedAt: string | null; cancelledAt: string | null; cancelReason: string | null;
}

const OVER: ReadonlySet<V.EventStatus> = new Set<V.EventStatus>(['finished', 'cancelled']);

function entryCount(db: DB, eventId: number): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM event_entries WHERE event_id = ? AND status NOT IN ('dropped','disqualified')")
    .get(eventId) as { n: number }).n;
}

/** Open events soonest first, then finished and cancelled ones newest first.
 *  Drafts only for staff, admins and mods (Ruling 14). */
export function eventListItems(db: DB, o: { staff: boolean }): EventListItem[] {
  const rows = (db.prepare('SELECT * FROM events ORDER BY starts_at, id').all() as E.EventRow[])
    .filter((e) => o.staff || e.status !== 'draft');
  const ordered = [...rows.filter((e) => !OVER.has(e.status)), ...rows.filter((e) => OVER.has(e.status)).reverse()];
  return ordered.map((e) => ({
    slug: e.slug, name: e.name, status: e.status, entryKind: e.entry_kind, official: e.official === 1, startsAt: e.starts_at,
    bannerKey: e.banner_key,
    format: E.stagesOf(db, e.id).map((s) => STAGE_LABEL[s.type]),
    entries: entryCount(db, e.id),
  }));
}

/** The snapshot once published; before that (a draft an admin previews), the
 *  chosen ruleset as a tournament would play it. */
function stageRules(db: DB, s: E.StageRow): MatchRules | null {
  const json = s.rules_json
    ?? (db.prepare('SELECT rules_json FROM rulesets WHERE id = ?').get(s.ruleset_id) as { rules_json: string } | undefined)?.rules_json;
  if (!json) return null;
  try {
    return rulesForKind('tournament', parseRules(json));
  } catch {
    return null;
  }
}

export function eventView(db: DB, ev: E.EventRow): EventView {
  const f = E.fieldsOf(ev);
  const rulesetName = db.prepare('SELECT name FROM rulesets WHERE id = ?');
  const configLabel = db.prepare('SELECT label FROM game_configs WHERE key = ?');
  return {
    slug: ev.slug, name: ev.name, status: ev.status, entryKind: ev.entry_kind, official: ev.official === 1,
    organizerName: getPlayer(db, ev.organizer_steamid)?.name ?? null, bannerKey: ev.banner_key,
    startsAt: ev.starts_at, description: ev.description, teamCap: ev.team_cap,
    eligibility: f.eligibility, checkin: f.checkin, roster: f.roster,
    stages: E.stagesOf(db, ev.id).map((s) => {
      const st = E.stageSettingsOf(s);
      const rules = stageRules(db, s);
      return {
        ordinal: s.ordinal, type: st.type, summary: stageSummary(st.type, st.config, st.advanceCount),
        veto: VETO_LABEL[st.vetoType], chapters: chaptersLabel(st.chapters), scheduling: st.scheduling,
        rulesetName: (rulesetName.get(st.rulesetId) as { name: string } | undefined)?.name ?? null,
        rules: rules ? rulesLines(rules) : [],
        gameConfig: (configLabel.get(st.gameConfig) as { label: string } | undefined)?.label ?? st.gameConfig,
        campaigns: st.campaignPool.map((slug) => ({ slug, name: campaignDisplayName(db, slug) })),
      };
    }),
    entries: db.prepare(
      "SELECT name, tag, seed, status FROM event_entries WHERE event_id = ? AND status <> 'dropped' ORDER BY seed IS NULL, seed, id",
    ).all(ev.id) as EventEntryView[],
    finishedAt: ev.finished_at, cancelledAt: ev.cancelled_at, cancelReason: ev.cancel_reason,
  };
}
```

- [ ] **Step 4: Write `src/routes/events.ts`**

```ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DB } from '../db.js';
import { getPlayer } from '../players.js';
import { makeOptionalViewer } from './guards.js';
import { competitiveAccess, competitivePublic } from '../teams/access.js';
import { getEventBySlug } from '../events/events.js';
import { eventListItems, eventView } from '../events/views.js';

const NOT_FOUND = { error: 'not found' };

/**
 * The public side of events (tournaments plan T1a): the list and one event
 * page, read only. Behind competitive_enabled exactly as the team pages are:
 * a signed-in viewer goes through competitiveAccess, a signed-out one is let
 * in only once the switch is at everyone. A draft is for staff, admins and
 * mods (Ruling 14): to anyone else it answers the very same 404 as a slug
 * that does not exist, so whether a draft exists cannot be read off the answer.
 */
export async function eventRoutes(app: FastifyInstance, opts: { db: DB }): Promise<void> {
  const { db } = opts;
  const optionalViewer = makeOptionalViewer(db);
  const allowedViewer = (req: FastifyRequest, reply: FastifyReply): { viewer: string | null } | null => {
    const viewer = optionalViewer(req);
    const allowed = viewer ? competitiveAccess(db, viewer) : competitivePublic(db);
    if (!allowed) { reply.code(404).send(NOT_FOUND); return null; }
    return { viewer };
  };
  const isStaff = (viewer: string | null): boolean => {
    const p = viewer ? getPlayer(db, viewer) : undefined;
    return !!p && (p.is_admin === 1 || p.is_mod === 1);
  };

  app.get('/api/events', async (req, reply) => {
    const v = allowedViewer(req, reply);
    if (!v) return;
    return { events: eventListItems(db, { staff: isStaff(v.viewer) }) };
  });

  app.get('/api/events/:slug', async (req, reply) => {
    const v = allowedViewer(req, reply);
    if (!v) return;
    const ev = getEventBySlug(db, (req.params as { slug: string }).slug);
    if (!ev || (ev.status === 'draft' && !isStaff(v.viewer))) return reply.code(404).send(NOT_FOUND);
    return eventView(db, ev);
  });
}
```

- [ ] **Step 5: Register the routes**

In `src/server.ts`, next to `import { teamRoutes } from './routes/teams.js';`:

```ts
import { eventRoutes } from './routes/events.js';
```

Right after the `await app.register(teamRoutes, { ... });` block (before the `// Purge community tombstones` comment):

```ts
  // Events (tournaments plan T1a): read only, behind the competitive switch.
  await app.register(eventRoutes, { db: deps.db });
```

- [ ] **Step 6: Run the tests and typecheck**

Run: `npx vitest run tests/eventRoutes.test.ts tests/adminEventRoutes.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/events/views.ts src/routes/events.ts src/server.ts tests/eventRoutes.test.ts
git commit -m "Events: public list and event page routes behind the competitive switch, drafts for staff only"
```

---
### Task 6: Event banners

**Files:**
- Modify: `src/community/validate.ts` (a banner section right after `checkLogo`)
- Modify: `src/community/store.ts` (`FileKind`, `FOLDER`, `EXT`, `putBanner`, `readBanner`)
- Modify: `src/community/sweep.ts` (banner references, entry-logo references, the kinds it walks)
- Modify: `src/events/events.ts` (append `setEventBanner`)
- Modify: `src/routes/adminEvents.ts` (store option, upload and remove routes)
- Modify: `src/routes/events.ts` (store option, the banner file route)
- Modify: `src/server.ts` (both registrations pass the store)
- Modify: `tests/eventLogGuard.test.ts` (one `MUTATIONS` entry)
- Test: `tests/eventBanners.test.ts` (new)

**Interfaces:**
- Consumes: `pngSize(b: Uint8Array): { w: number; h: number } | null` (`src/hudFiles.ts`); the `Checked<T>`, `pass`, `bad`, `tooBig` helpers inside `src/community/validate.ts`; `CommunityStore` (`src/community/store.ts`: `canTake(extra): Promise<boolean>`, the private `write`/`read`); `getCommunityStore` in `src/server.ts` (defined before both registrations); Task 3 `E.*`, `logEvent`; Task 4 `refuse`, `idOf`, `action`, `requireAdmin` inside `adminEventRoutes`; Task 5 `allowedViewer`, `isStaff` inside `eventRoutes`.
- Produces:
  - `src/community/validate.ts`: `BANNER_W = 1600`, `BANNER_H = 400`, `BANNER_MAX_BYTES = 1024 * 1024`, `type BannerType = 'png' | 'webp'`, `webpSize(b: Uint8Array): { w: number; h: number } | null`, `bannerType(bytes: Uint8Array): BannerType | null`, `checkBanner(bytes: Uint8Array): Checked<{ w: number; h: number; type: BannerType }>`.
  - `src/community/store.ts`: `FileKind` gains `'banner'` (folder `banners`, extension `.img`); `putBanner(bytes): { name: string; wrote: boolean }`, `readBanner(sha: string): Buffer | null`.
  - `src/events/events.ts`: `setEventBanner(db, o: { eventId: number; by: string; bannerKey: string | null; now?: Date }): EventResult<EventRow>` (actions `banner_set` / `banner_removed`; the same key again writes nothing).
  - HTTP: `POST /api/admin/events/:id/banner` body `{ image: <base64> }` -> `{ bannerKey }` (admin; `logAdmin` `event_banner`); `POST /api/admin/events/:id/banner/remove` -> `{ ok: true }` (admin; `logAdmin` `event_banner_remove`); `GET /api/events/banners/:key` -> the image as `image/png` or `image/webp`, 404 unless an event the viewer may see (Task 5 rules: switch, drafts staff only) holds the key.
  - `adminEventRoutes` and `eventRoutes` options become `{ db: DB; store: () => CommunityStore }`.

- [ ] **Step 1: Write the failing tests**

`tests/eventBanners.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { CommunityStore } from '../src/community/store.js';
import { BANNER_MAX_BYTES, bannerType, checkBanner, webpSize } from '../src/community/validate.js';
import { ORPHAN_GRACE_MS, sweepCommunity } from '../src/community/sweep.js';
import * as E from '../src/events/events.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import { png } from './pngFixture.js';
import { ADMIN, NOW, eventFixture, must } from './eventFixture.js';

/** The first 30 bytes of a WebP of each kind, enough for webpSize, then padding. */
function webp(kind: 'VP8 ' | 'VP8L' | 'VP8X', w: number, h: number, pad = 64): Buffer {
  const b = Buffer.alloc(30 + pad);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(b.length - 8, 4);
  b.write('WEBP', 8, 'latin1');
  b.write(kind, 12, 'latin1');
  b.writeUInt32LE(b.length - 20, 16);
  if (kind === 'VP8 ') {
    b[23] = 0x9d; b[24] = 0x01; b[25] = 0x2a;
    b.writeUInt16LE(w, 26);
    b.writeUInt16LE(h, 28);
  } else if (kind === 'VP8L') {
    const bits = (w - 1) | ((h - 1) << 14);
    b[20] = 0x2f;
    b.writeUInt32LE(bits >>> 0, 21);
  } else {
    b.writeUIntLE(w - 1, 24, 3);
    b.writeUIntLE(h - 1, 27, 3);
  }
  return b;
}

describe('banner checks', () => {
  it('reads the size of all three WebP kinds, and nothing else as a WebP', () => {
    expect(webpSize(webp('VP8 ', 1600, 400))).toEqual({ w: 1600, h: 400 });
    expect(webpSize(webp('VP8L', 1600, 400))).toEqual({ w: 1600, h: 400 });
    expect(webpSize(webp('VP8X', 1600, 400))).toEqual({ w: 1600, h: 400 });
    expect(webpSize(png(1600, 400))).toBeNull();
    expect(webpSize(Buffer.from('RIFF....WAVEfmt '))).toBeNull();
  });

  it('takes a 1600 x 400 PNG or WebP up to 1 MB, and nothing else', () => {
    expect(checkBanner(png(1600, 400))).toEqual({ ok: true, value: { w: 1600, h: 400, type: 'png' } });
    expect(checkBanner(webp('VP8X', 1600, 400))).toEqual({ ok: true, value: { w: 1600, h: 400, type: 'webp' } });
    expect(checkBanner(png(1600, 401))).toMatchObject({ ok: false, status: 400 });
    expect(checkBanner(Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array(40).fill(0)]))).toMatchObject({ ok: false, status: 400, error: 'The banner is not a PNG or WebP image.' });
    expect(checkBanner(Buffer.alloc(BANNER_MAX_BYTES + 1))).toMatchObject({ ok: false, status: 413 });
    expect(bannerType(webp('VP8 ', 1600, 400))).toBe('webp');
  });
});

describe('banner files', () => {
  it('stay through the sweep while any event holds them, and an entry logo snapshot keeps its logo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'banners-'));
    const store = new CommunityStore({ dir, maxBytes: () => 1e9, freeBytes: async () => 1e12 });
    const used = store.putBanner(png(1600, 400));
    const spare = store.putBanner(webp('VP8X', 1600, 400));
    const logo = store.putLogo(png(256, 256));
    const f = eventFixture('announced');
    must(E.setEventBanner(f.db, { eventId: f.eventId, by: ADMIN, bannerKey: used.name, now: NOW }));
    must(E.cancelEvent(f.db, { eventId: f.eventId, by: ADMIN, reason: null, now: NOW }));
    f.db.prepare("INSERT INTO event_entries (event_id, name, logo_key, registered_by, created_at) VALUES (?, 'Rats', ?, ?, 'x')")
      .run(f.eventId, logo.name, ADMIN);
    const old = (Date.now() - ORPHAN_GRACE_MS - 60_000) / 1000;
    for (const kind of ['banner', 'logo'] as const) for (const file of store.list(kind)) utimesSync(file.file, old, old);
    sweepCommunity(f.db, store, new Date());
    expect(store.readBanner(used.name)).not.toBeNull();
    expect(store.readBanner(spare.name)).toBeNull();
    expect(store.readLogo(logo.name)).not.toBeNull();
  });
});

describe('setEventBanner', () => {
  it('sets, keeps quiet on the same key, removes, and refuses a key that is not a sha256', () => {
    const f = eventFixture();
    const key = 'b'.repeat(64);
    expect(must(E.setEventBanner(f.db, { eventId: f.eventId, by: ADMIN, bannerKey: key, now: NOW })).banner_key).toBe(key);
    must(E.setEventBanner(f.db, { eventId: f.eventId, by: ADMIN, bannerKey: key, now: NOW }));
    expect(must(E.setEventBanner(f.db, { eventId: f.eventId, by: ADMIN, bannerKey: null, now: NOW })).banner_key).toBeNull();
    expect(E.eventLog(f.db, f.eventId).map((l) => l.action).slice(-2)).toEqual(['banner_set', 'banner_removed']);
    expect(E.setEventBanner(f.db, { eventId: f.eventId, by: ADMIN, bannerKey: '../etc', now: NOW })).toEqual({ ok: false, error: 'bad_request' });
    expect(E.setEventBanner(f.db, { eventId: 999, by: ADMIN, bannerKey: null, now: NOW })).toEqual({ ok: false, error: 'not_found' });
  });
});

describe('banner routes', () => {
  const MOD = '76561199000000741';
  const PLAYER = '76561199000000742';
  let db: DB;
  let app: FastifyInstance;
  let cookies: Record<string, Record<string, string>>;
  beforeEach(async () => {
    db = openDb(':memory:');
    app = await buildServer({
      config: { ...loadConfig({}), communityDir: mkdtempSync(join(tmpdir(), 'eventbanners-')) },
      db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {},
    });
    cookies = {};
    for (const id of [ADMIN, MOD, PLAYER]) cookies[id] = authedCookie(app, db, id);
    db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
    db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
    db.prepare("UPDATE settings SET value = 'everyone' WHERE key = 'competitive_enabled'").run();
  });
  afterEach(async () => { await app.close(); });
  const call = (method: 'GET' | 'POST', url: string, as?: string, payload?: object) =>
    app.inject({ method, url, cookies: as ? cookies[as] : undefined, payload });
  const draftEvent = () => must(E.createEvent(db, {
    by: ADMIN, fields: { name: 'Banner Cup', startsAt: new Date(Date.now() + 7 * 86_400_000).toISOString(), entryKind: 'team' },
  }));

  it('an admin uploads a banner; it is audited twice and served as its own type', async () => {
    const ev = draftEvent();
    const image = webp('VP8X', 1600, 400).toString('base64');
    const up = await call('POST', `/api/admin/events/${ev.id}/banner`, ADMIN, { image });
    expect(up.statusCode).toBe(200);
    const { bannerKey } = up.json();
    expect(E.getEvent(db, ev.id)!.banner_key).toBe(bannerKey);
    expect(E.eventLog(db, ev.id).at(-1)!.action).toBe('banner_set');
    expect(db.prepare("SELECT target FROM admin_actions WHERE action = 'event_banner'").get()).toEqual({ target: String(ev.id) });
    const got = await call('GET', `/api/events/banners/${bannerKey}`, ADMIN);
    expect([got.statusCode, got.headers['content-type'], got.headers['x-content-type-options']]).toEqual([200, 'image/webp', 'nosniff']);
  });

  it('refuses a wrong size, a non-image, an over-large body, a mod and a player', async () => {
    const ev = draftEvent();
    const bad = await call('POST', `/api/admin/events/${ev.id}/banner`, ADMIN, { image: png(800, 400).toString('base64') });
    expect([bad.statusCode, bad.json()]).toEqual([400, { error: 'The banner must be 1600 x 400.' }]);
    expect((await call('POST', `/api/admin/events/${ev.id}/banner`, ADMIN, { image: 'not base64 at all' })).statusCode).toBe(400);
    expect((await call('POST', `/api/admin/events/${ev.id}/banner`, ADMIN, {})).statusCode).toBe(400);
    expect((await call('POST', `/api/admin/events/${ev.id}/banner`, ADMIN, { image: Buffer.alloc(BANNER_MAX_BYTES + 10).toString('base64') })).statusCode).toBe(413);
    for (const who of [MOD, PLAYER]) {
      expect((await call('POST', `/api/admin/events/${ev.id}/banner`, who, { image: png(1600, 400).toString('base64') })).statusCode).toBe(403);
    }
    expect((await call('POST', '/api/admin/events/999/banner', ADMIN, { image: png(1600, 400).toString('base64') })).statusCode).toBe(404);
    expect(E.getEvent(db, ev.id)!.banner_key).toBeNull();
  });

  it('serves a banner only while an event the viewer may see holds it', async () => {
    const ev = draftEvent();
    const { bannerKey } = (await call('POST', `/api/admin/events/${ev.id}/banner`, ADMIN, { image: png(1600, 400).toString('base64') })).json();
    expect((await call('GET', `/api/events/banners/${bannerKey}`, PLAYER)).statusCode).toBe(404);
    expect((await call('GET', `/api/events/banners/${bannerKey}`, MOD)).statusCode).toBe(200);
    db.prepare("UPDATE events SET status = 'announced' WHERE id = ?").run(ev.id);
    const open = await call('GET', `/api/events/banners/${bannerKey}`);
    expect([open.statusCode, open.headers['content-type']]).toEqual([200, 'image/png']);
    expect((await call('POST', `/api/admin/events/${ev.id}/banner/remove`, ADMIN)).statusCode).toBe(200);
    expect((await call('GET', `/api/events/banners/${bannerKey}`)).statusCode).toBe(404);
    expect((await call('GET', '/api/events/banners/not-a-key')).statusCode).toBe(404);
    expect(db.prepare("SELECT COUNT(*) AS n FROM admin_actions WHERE action = 'event_banner_remove'").get()).toEqual({ n: 1 });
  });
});
```

In `tests/eventLogGuard.test.ts`, add to `MUTATIONS` after the `cancelEvent` entry:

```ts
  setEventBanner: { from: 'announced', action: 'banner_set', run: ({ db, eventId }) => E.setEventBanner(db, { eventId, by: ADMIN, bannerKey: 'a'.repeat(64), now: NOW }) },
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/eventBanners.test.ts tests/eventLogGuard.test.ts`
Expected: FAIL with `webpSize` and `checkBanner` not exported, `E.setEventBanner is not a function`, and the guard's `setEventBanner` cases failing.

- [ ] **Step 3: Check banners in `src/community/validate.ts`**

Right after the `checkLogo` function (before `// ---- Imported HUD`):

```ts
// ---- Event banner ----------------------------------------------------------

/** Event banners (tournaments plan T1a) are 4:1. The admin's browser crops
 *  and scales whatever they pick (PNG, JPEG or WebP) to exactly this size and
 *  re-encodes it as WebP, or PNG where the browser cannot write WebP
 *  (web/src/eventBanner.ts), so the server only ever stores those two. */
export const BANNER_W = 1600;
export const BANNER_H = 400;
export const BANNER_MAX_BYTES = 1024 * 1024;
export type BannerType = 'png' | 'webp';

/** Width and height from a WebP's first chunk (VP8, VP8L or VP8X), or null
 *  when the bytes are not a WebP. */
export function webpSize(b: Uint8Array): { w: number; h: number } | null {
  if (b.length < 30) return null;
  const tag = (o: number) => String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WEBP') return null;
  const chunk = tag(12);
  let w = 0;
  let h = 0;
  if (chunk === 'VP8 ') {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    w = (b[26]! | (b[27]! << 8)) & 0x3fff;
    h = (b[28]! | (b[29]! << 8)) & 0x3fff;
  } else if (chunk === 'VP8L') {
    if (b[20] !== 0x2f) return null;
    w = 1 + (b[21]! | ((b[22]! & 0x3f) << 8));
    h = 1 + ((b[22]! >> 6) | (b[23]! << 2) | ((b[24]! & 0x0f) << 10));
  } else if (chunk === 'VP8X') {
    w = 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16));
    h = 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16));
  } else {
    return null;
  }
  return w > 0 && h > 0 ? { w, h } : null;
}

/** The image type from its first bytes: what the banner route serves it as. */
export function bannerType(bytes: Uint8Array): BannerType | null {
  if (pngSize(bytes)) return 'png';
  if (webpSize(bytes)) return 'webp';
  return null;
}

export function checkBanner(bytes: Uint8Array): Checked<{ w: number; h: number; type: BannerType }> {
  if (bytes.length > BANNER_MAX_BYTES) return tooBig('The banner is over 1 MB.');
  const png = pngSize(bytes);
  const size = png ?? webpSize(bytes);
  if (!size) return bad('The banner is not a PNG or WebP image.');
  if (size.w !== BANNER_W || size.h !== BANNER_H) return bad(`The banner must be ${BANNER_W} x ${BANNER_H}.`);
  return pass({ ...size, type: png ? 'png' : 'webp' });
}
```

- [ ] **Step 4: Teach the store and the sweep**

In `src/community/store.ts`, replace

```ts
export type FileKind = 'preview' | 'import' | 'logo';

const FOLDER: Record<FileKind, string> = { preview: 'previews', import: 'imports', logo: 'logos' };
const EXT: Record<FileKind, string> = { preview: '.png', import: '.vpk', logo: '.png' };
```

with

```ts
export type FileKind = 'preview' | 'import' | 'logo' | 'banner';

const FOLDER: Record<FileKind, string> = { preview: 'previews', import: 'imports', logo: 'logos', banner: 'banners' };
// A banner is a PNG or a WebP (src/community/validate.ts checkBanner); the
// banner route reads which from the bytes, so the name does not say.
const EXT: Record<FileKind, string> = { preview: '.png', import: '.vpk', logo: '.png', banner: '.img' };
```

Right after `putLogo`:

```ts
  /** An event banner (src/events), content addressed like a logo. */
  putBanner(bytes: Uint8Array): { name: string; wrote: boolean } {
    const name = createHash('sha256').update(bytes).digest('hex');
    return { name, wrote: this.write('banner', name, bytes) };
  }
```

Right after `readLogo(...)`:

```ts
  readBanner(sha: string): Buffer | null { return this.read('banner', sha); }
```

In `src/community/sweep.ts`, replace the `logo:` entry of `refs` with

```ts
    // A logo stays while any team, live or disbanded, points at it: a
    // disbanded team's page still shows its logo. An event entry's logo is a
    // snapshot of its team's (tournaments plan T1b) and keeps the file too,
    // so an archived event never loses it to a later logo change.
    logo: new Set((db.prepare(
      `SELECT logo_key AS v FROM teams WHERE logo_key IS NOT NULL
       UNION SELECT logo_key FROM event_entries WHERE logo_key IS NOT NULL`,
    ).all() as { v: string }[]).map((r) => r.v)),
    // A banner stays while any event, of any status, holds it: event pages
    // are permanent.
    banner: new Set((db.prepare('SELECT DISTINCT banner_key AS v FROM events WHERE banner_key IS NOT NULL').all() as { v: string }[]).map((r) => r.v)),
```

and replace the two kind lists:

```ts
  const justPurged: Record<FileKind, Set<string>> = { preview: new Set(), import: new Set(), logo: new Set(), banner: new Set() };
```

```ts
  for (const kind of ['preview', 'import', 'logo', 'banner'] as FileKind[]) {
```

- [ ] **Step 5: Set the banner on the event**

Append to `src/events/events.ts`:

```ts
const BANNER_KEY = /^[0-9a-f]{64}$/;

/** Set or clear the banner (Ruling 4). Any status: a finished event's page
 *  keeps a banner, and a new one may still go up for the archive. The file is
 *  already in the community store; setting the key that is there already
 *  writes nothing. */
export function setEventBanner(db: DB, o: { eventId: number; by: string; bannerKey: string | null; now?: Date }): EventResult<EventRow> {
  const at = iso(o.now);
  if (o.bannerKey !== null && !BANNER_KEY.test(o.bannerKey)) return V.fail('bad_request');
  return db.transaction((): EventResult<EventRow> => {
    const ev = getEvent(db, o.eventId);
    if (!ev) return V.fail('not_found');
    if (ev.banner_key === o.bannerKey) return V.ok(ev);
    db.prepare('UPDATE events SET banner_key = ?, updated_at = ? WHERE id = ?').run(o.bannerKey, at, ev.id);
    logEvent(db, ev.id, o.by, o.bannerKey ? 'banner_set' : 'banner_removed', at, { bannerKey: o.bannerKey, previous: ev.banner_key });
    return V.ok(getEvent(db, ev.id)!);
  })();
}
```

- [ ] **Step 6: Upload, remove and serve**

In `src/routes/adminEvents.ts`, add the imports after `import type { DB } from '../db.js';`:

```ts
import type { CommunityStore } from '../community/store.js';
import { BANNER_MAX_BYTES, checkBanner } from '../community/validate.js';
```

change the signature to `export async function adminEventRoutes(app: FastifyInstance, opts: { db: DB; store: () => CommunityStore }): Promise<void> {`, and add before its closing `}`:

```ts
  /** Upload a banner (Ruling 4): base64 of the browser's 1600 x 400 PNG or
   *  WebP, checked, stored content addressed, then set on the event. */
  app.post('/api/admin/events/:id/banner', { bodyLimit: Math.ceil(BANNER_MAX_BYTES * 1.4) + 1024 }, async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const id = idOf((req.params as { id: string }).id);
    if (id === null || !E.getEvent(db, id)) return refuse(reply, 'not_found');
    const raw = ((req.body ?? {}) as { image?: unknown }).image;
    if (typeof raw !== 'string') return reply.code(400).send({ error: 'The banner is missing.' });
    const bytes = Buffer.from(raw, 'base64');
    const checked = checkBanner(bytes);
    if (!checked.ok) return reply.code(checked.status).send({ error: checked.error });
    const store = opts.store();
    if (!(await store.canTake(bytes.length))) return reply.code(507).send({ error: 'The community shelf is full right now.' });
    const { name } = store.putBanner(bytes);
    const r = E.setEventBanner(db, { eventId: id, by: me, bannerKey: name });
    if (!r.ok) return refuse(reply, r.error);
    logAdmin(db, me, 'event_banner', id, { bannerKey: name });
    return { bannerKey: name };
  });

  action('/api/admin/events/:id/banner/remove', 'event_banner_remove',
    (me, id) => E.setEventBanner(db, { eventId: id, by: me, bannerKey: null }));
```

In `src/routes/events.ts`, add the imports after `import type { DB } from '../db.js';`:

```ts
import type { CommunityStore } from '../community/store.js';
import { bannerType } from '../community/validate.js';
```

add `const HEX64 = /^[0-9a-f]{64}$/;` under `NOT_FOUND`, change the signature to `export async function eventRoutes(app: FastifyInstance, opts: { db: DB; store: () => CommunityStore }): Promise<void> {`, and add right before `app.get('/api/events/:slug', ...)` (the paths differ in depth, so the slug route never sees `banners`; `banners` is a reserved slug anyway):

```ts
  /** A banner, only while an event this viewer may see holds it (Ruling 4):
   *  a draft's banner is staff only, like the draft. Served as the type its
   *  bytes are, with the same lockdown headers as a team logo. */
  app.get('/api/events/banners/:key', async (req, reply) => {
    const v = allowedViewer(req, reply);
    if (!v) return;
    const key = (req.params as { key: string }).key;
    if (!HEX64.test(key)) return reply.code(404).send(NOT_FOUND);
    const holders = db.prepare('SELECT status FROM events WHERE banner_key = ?').all(key) as { status: string }[];
    if (!holders.some((h) => h.status !== 'draft' || isStaff(v.viewer))) return reply.code(404).send(NOT_FOUND);
    const bytes = opts.store().readBanner(key);
    const type = bytes ? bannerType(bytes) : null;
    if (!bytes || !type) return reply.code(404).send(NOT_FOUND);
    return reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Cache-Control', 'public, max-age=3600')
      .type(type === 'png' ? 'image/png' : 'image/webp').send(bytes);
  });
```

In `src/server.ts`, pass the store to both:

```ts
  await app.register(adminEventRoutes, { db: deps.db, store: getCommunityStore });
```

```ts
  await app.register(eventRoutes, { db: deps.db, store: getCommunityStore });
```

- [ ] **Step 7: Run the tests and typecheck**

Run: `npx vitest run tests/eventBanners.test.ts tests/eventLogGuard.test.ts tests/teamLogos.test.ts tests/adminEventRoutes.test.ts tests/eventRoutes.test.ts && npm run typecheck`
Expected: PASS, no type errors. `tests/teamLogos.test.ts` still passes: logos are swept as before.

- [ ] **Step 8: Commit**

```bash
git add src/community/validate.ts src/community/store.ts src/community/sweep.ts src/events/events.ts src/routes/adminEvents.ts src/routes/events.ts src/server.ts tests/eventBanners.test.ts tests/eventLogGuard.test.ts
git commit -m "Events: banners, checked and stored like team logos, served only while a visible event holds them"
```

---

### Task 7: Web API, time helpers, and the Events desk list and create form

**Files:**
- Modify: `web/src/api.ts` (event types and `eventsApi` right after the `teamsApi` object; admin event types right after the `AdminBookingRow` interface; admin calls inside `adminApi` right after the `excuseBooking:` line)
- Create: `web/src/eventFormat.ts`
- Modify: `web/src/routes/admin/adminRoutes.ts`
- Modify: `web/src/routes/Admin.tsx`
- Create: `web/src/routes/admin/events/EventsDesk.tsx`
- Test: `web/src/eventFormat.test.ts`, `web/src/routes/admin/adminRoutes.test.ts` (one case, edited lines), `web/src/routes/admin/events/EventsDesk.test.tsx`

Task 7 mounts only the `list` section; the `event` section (one event's editor) is mounted in Task 9 together with its component. Until then `/admin/events/12` renders the desk strip with an empty body.

**Interfaces:**
- Consumes: the HTTP shapes of Tasks 4, 5 and 6.
- Produces (`web/src/api.ts`, mirrors of the server types):
  - `type EventStatus`, `type EntryKind`, `type StageType`, `type VetoType`, `type Scheduling` (same string unions as `src/events/validate.ts`).
  - `interface EventEligibility`, `interface EventCheckin`, `type RosterLock`, `interface EventRoster`, `interface StageConfigs`, `type StageConfig`, `interface StageSettings`, `interface EventFields` (same fields as the server's `Eligibility`, `Checkin`, `RosterLock`, `RosterRules`, `StageConfigs`, `StageConfig`, `StageSettings`, `EventFields`).
  - `interface EventListItem`, `interface EventStageView`, `interface EventEntryView`, `interface EventView` (as `src/events/views.ts`).
  - `interface AdminEventRow`, `interface AdminEventStage`, `interface AdminEventDetail`, `interface AdminEventOptions` (as `src/routes/adminEvents.ts`).
  - `eventsApi.list(signal?): Promise<{ events: EventListItem[] }>`, `eventsApi.get(slug, signal?): Promise<EventView>`, `bannerUrl(key: string): string`.
  - On `adminApi`: `events(signal?)`, `eventOptions(signal?)`, `event(id, signal?)`, `createEvent(body: { name: string; startsAt: string; entryKind: EntryKind }): Promise<{ id: number; slug: string }>`, `updateEvent(id, fields: Partial<EventFields>)`, `addStage(id, stage: StageSettings)`, `updateStage(id, stageId, stage: StageSettings)`, `removeStage(id, stageId)`, `reorderStages(id, order: number[])`, `publishEvent(id)`, `openEventRegistration(id)`, `cancelEvent(id, reason: string)`, `setEventBanner(id, image: string): Promise<{ bannerKey: string }>`, `removeEventBanner(id)`.
- Produces (`web/src/eventFormat.ts`): `STATUS_LABEL: Record<EventStatus, string>`, `untilText(iso: string, nowMs?: number): string`, `whenText(iso: string): string`, `toLocalInput(iso: string): string`, `fromLocalInput(value: string): string | null`.
- Produces (`adminRoutes.ts`): `Desk` gains `'events'`; `DESKS` gains `{ key: 'events', label: 'Events', path: '/admin/events' }` after People; `eventAdminUrl(id: number | string): string`; `parseAdminPath` returns `{ desk: 'events', section: 'list' | 'event' | 'unknown', param }` for admins and moderators alike; `deskItems(false)` is Live, People and Events; `legacyRedirect` leaves a moderator on `/admin/events...`.
- Produces: `EventsDesk({ canEdit }: { canEdit: boolean })` (the create form only when `canEdit`).

- [ ] **Step 1: Write the failing tests**

`web/src/eventFormat.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { STATUS_LABEL, fromLocalInput, toLocalInput, untilText } from './eventFormat';

const now = Date.parse('2026-10-01T12:00:00.000Z');
const at = (mins: number) => new Date(now + mins * 60_000).toISOString();

describe('untilText', () => {
  it('counts down in minutes, hours, then days', () => {
    expect(untilText(at(42), now)).toBe('in 42 min');
    expect(untilText(at(5 * 60 + 10), now)).toBe('in 5 h 10 min');
    expect(untilText(at(30 * 60), now)).toBe('in 30 h 0 min');
    expect(untilText(at(51 * 60), now)).toBe('in 2 days 3 h');
  });

  it('rounds a part minute up, and says starting now at or after the start', () => {
    expect(untilText(new Date(now + 20_000).toISOString(), now)).toBe('in 1 min');
    expect(untilText(at(0), now)).toBe('starting now');
    expect(untilText(at(-5), now)).toBe('starting now');
    expect(untilText('nonsense', now)).toBe('starting now');
  });
});

describe('datetime-local conversion', () => {
  it('reads back the same instant in whatever zone the viewer is in', () => {
    for (const iso of ['2026-10-10T20:00:00.000Z', '2026-03-08T18:30:00.000Z', '2026-11-01T18:15:00.000Z', '2026-12-31T23:59:00.000Z']) {
      expect(toLocalInput(iso)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
      expect(fromLocalInput(toLocalInput(iso))).toBe(iso);
    }
  });

  it('refuses anything that is not a datetime-local value', () => {
    expect(fromLocalInput('')).toBeNull();
    expect(fromLocalInput('2026-10-10')).toBeNull();
    expect(fromLocalInput('tomorrow')).toBeNull();
    expect(toLocalInput('nonsense')).toBe('');
  });

  it('names every status', () => {
    expect(STATUS_LABEL.registration).toBe('Registration open');
    expect(Object.keys(STATUS_LABEL)).toHaveLength(7);
  });
});
```

Add to `web/src/routes/admin/adminRoutes.test.ts`: change the import line to

```ts
import { ADMIN_ROUTE_PATHS, deskItems, eventAdminUrl, fileUrl, landingFor, legacyRedirect, parseAdminPath, ticketUrl } from './adminRoutes';
```

replace

```ts
    expect(deskItems(false).map((d) => d.key)).toEqual(['live', 'people']);
    expect(deskItems(true).map((d) => d.key)).toEqual(['live', 'people', 'setup', 'balance']);
```

with

```ts
    expect(deskItems(false).map((d) => d.key)).toEqual(['live', 'people', 'events']);
    expect(deskItems(true).map((d) => d.key)).toEqual(['live', 'people', 'events', 'setup', 'balance']);
```

add `'/admin/events', '/admin/events/12',` to the URL list in `declares route paths that reach every screen`, and add this case inside `describe('the panel URL parser', ...)`:

```ts
  it('parses the Events desk, for admins and (to read) moderators', () => {
    for (const who of [asAdmin, asMod]) {
      expect(parseAdminPath('/admin/events', who)).toEqual({ desk: 'events', section: 'list', param: null });
      expect(parseAdminPath('/admin/events/12', who)).toEqual({ desk: 'events', section: 'event', param: '12' });
      expect(parseAdminPath('/admin/events/abc', who)).toEqual({ desk: 'events', section: 'unknown', param: null });
      expect(parseAdminPath('/admin/events/12/x', who)).toEqual({ desk: 'events', section: 'unknown', param: null });
    }
    expect(legacyRedirect('/admin/events', '', false)).toBeNull();
    expect(legacyRedirect('/admin/events/12', '', false)).toBeNull();
    expect(legacyRedirect('/admin/eventsfoo', '', false)).toBe('/admin/people');
    expect(eventAdminUrl(12)).toBe('/admin/events/12');
  });
```

`web/src/routes/admin/events/EventsDesk.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { AdminEventRow } from '../../../api';

const { mockAdmin } = vi.hoisted(() => ({ mockAdmin: { events: vi.fn(), createEvent: vi.fn() } }));
vi.mock('../../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api')>();
  return { ...actual, adminApi: { ...actual.adminApi, ...mockAdmin } };
});
const { EventsDesk } = await import('./EventsDesk');
const { LocationProvider } = await import('preact-iso');

const ROW: AdminEventRow = {
  id: 3, slug: 'riverside-cup', name: 'Riverside Cup', status: 'draft', entryKind: 'team',
  startsAt: '2026-10-10T20:00:00.000Z', stages: 2, updatedAt: '2026-10-01T12:00:00.000Z',
};

afterEach(() => { cleanup(); history.replaceState(null, '', '/'); });
beforeEach(() => { for (const f of Object.values(mockAdmin)) f.mockReset(); });

const show = (canEdit = true) => render(<LocationProvider><EventsDesk canEdit={canEdit} /></LocationProvider>);

describe('EventsDesk', () => {
  it('lists every event with its status and stage count, each a link to its editor', async () => {
    mockAdmin.events.mockResolvedValue({ events: [ROW] });
    show();
    const name = await screen.findByText('Riverside Cup');
    expect((name.closest('a') as HTMLAnchorElement).getAttribute('href')).toBe('/admin/events/3');
    expect(screen.getByText('Draft')).toBeTruthy();
    expect(screen.getByText(/2 stages/)).toBeTruthy();
  });

  it('creates a draft from the name, the local start and the kind, then opens it', async () => {
    mockAdmin.events.mockResolvedValue({ events: [] });
    mockAdmin.createEvent.mockResolvedValue({ id: 7, slug: 'spring-cup' });
    show();
    await screen.findByText('No events yet.');
    fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'Spring Cup' } });
    fireEvent.input(screen.getByLabelText('Starts at'), { target: { value: '2026-10-10T20:00' } });
    fireEvent.change(screen.getByLabelText('Entry kind'), { target: { value: 'draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));
    await waitFor(() => expect(mockAdmin.createEvent).toHaveBeenCalledWith({
      name: 'Spring Cup', startsAt: new Date('2026-10-10T20:00').toISOString(), entryKind: 'draft',
    }));
    await waitFor(() => expect(location.pathname).toBe('/admin/events/7'));
  });

  it('a mod reads the list with no create form', async () => {
    mockAdmin.events.mockResolvedValue({ events: [ROW] });
    show(false);
    expect(await screen.findByText('Riverside Cup')).toBeTruthy();
    expect(screen.queryByText('New event')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create draft' })).toBeNull();
  });

  it('asks for a start time instead of sending none', async () => {
    mockAdmin.events.mockResolvedValue({ events: [] });
    show();
    await screen.findByText('No events yet.');
    fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'Spring Cup' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));
    expect(await screen.findByText('Pick a start time.')).toBeTruthy();
    expect(mockAdmin.createEvent).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run web/src/eventFormat.test.ts web/src/routes/admin/adminRoutes.test.ts web/src/routes/admin/events/EventsDesk.test.tsx`
Expected: FAIL with missing modules `./eventFormat` and `./EventsDesk`, and `eventAdminUrl` not exported.

- [ ] **Step 3: Add the API types and calls**

In `web/src/api.ts`, right after the closing `};` of `export const teamsApi = { ... };`:

```ts
// ---------- events (tournaments plan T1a; mirrors src/events/validate.ts, src/events/views.ts) ----------

export type EventStatus = 'draft' | 'announced' | 'registration' | 'checkin' | 'live' | 'finished' | 'cancelled';
export type EntryKind = 'team' | 'draft';
export type StageType = 'single_elim' | 'double_elim' | 'round_robin' | 'swiss' | 'league';
export type VetoType = 'ban_to_one' | 'home_away' | 'pick_ban';
export type Scheduling = 'rolling' | 'window';
export interface EventEligibility { minPugs: number; requireDiscord: boolean; srFloor: number | null; srCeiling: number | null }
export interface EventCheckin { enabled: boolean; opensMinutes: number; closesMinutes: number }
export type RosterLock = { kind: 'none' } | { kind: 'at'; at: string } | { kind: 'after_round'; stage: number; round: number };
export interface EventRoster { starters: 4; maxSubs: number; lock: RosterLock; maxAdditions: number | null }
export interface StageConfigs {
  single_elim: { thirdPlace: boolean };
  double_elim: { grandFinalReset: boolean };
  round_robin: { groups: number };
  swiss: { rounds: number };
  league: { weeks: number; matchesPerWeek: number; pairing: 'swiss' | 'round_robin' };
}
export type StageConfig = StageConfigs[StageType];
export interface StageSettings {
  type: StageType; config: StageConfig; rulesetId: number; gameConfig: string; campaignPool: string[];
  vetoType: VetoType; chapters: number | null; scheduling: Scheduling; advanceCount: number | null;
}
export interface EventFields {
  name: string; startsAt: string; entryKind: EntryKind; official: boolean; teamCap: number | null; description: string;
  eligibility: EventEligibility; checkin: EventCheckin; roster: EventRoster;
}
export interface EventListItem {
  slug: string; name: string; status: EventStatus; entryKind: EntryKind; official: boolean; startsAt: string; bannerKey: string | null;
  format: string[]; entries: number;
}
export interface EventStageView {
  ordinal: number; type: StageType; summary: string; veto: string; chapters: string; scheduling: Scheduling;
  rulesetName: string | null; rules: string[]; gameConfig: string; campaigns: { slug: string; name: string }[];
}
export interface EventEntryView { name: string; tag: string; seed: number | null; status: string }
export interface EventView {
  slug: string; name: string; status: EventStatus; entryKind: EntryKind; official: boolean; organizerName: string | null;
  bannerKey: string | null; startsAt: string; description: string; teamCap: number | null;
  eligibility: EventEligibility; checkin: EventCheckin; roster: EventRoster;
  stages: EventStageView[]; entries: EventEntryView[];
  finishedAt: string | null; cancelledAt: string | null; cancelReason: string | null;
}

export const bannerUrl = (key: string): string => `/api/events/banners/${key}`;

export const eventsApi = {
  list: (signal?: AbortSignal) => get<{ events: EventListItem[] }>('/api/events', signal),
  get: (slug: string, signal?: AbortSignal) => get<EventView>(`/api/events/${enc(slug)}`, signal),
};
```

Right after the `export interface AdminBookingRow { ... }` block (before `export const adminApi = {`):

```ts
/** src/routes/adminEvents.ts */
export interface AdminEventRow {
  id: number; slug: string; name: string; status: EventStatus; entryKind: EntryKind; startsAt: string; stages: number; updatedAt: string;
}
export interface AdminEventStage { id: number; ordinal: number; summary: string; settings: StageSettings; rulesSnapshotted: boolean }
export interface AdminEventDetail {
  id: number; slug: string; status: EventStatus; fields: EventFields; bannerKey: string | null;
  cancelReason: string | null; createdAt: string; updatedAt: string;
  stages: AdminEventStage[];
  log: { at: string; actorName: string | null; action: string; detail: Record<string, unknown> }[];
}
export interface AdminEventOptions {
  campaigns: { slug: string; name: string }[]; defaultPool: string[];
  rulesets: { id: number; name: string }[]; defaultRulesetId: number | null;
  gameConfigs: { key: string; label: string }[];
  defaults: { eligibility: EventEligibility; checkin: EventCheckin; roster: EventRoster };
}
```

Inside `export const adminApi = { ... }`, right after the `excuseBooking: ...` line:

```ts
  /** The Events desk (tournaments plan T1a). */
  events: (signal?: AbortSignal) => get<{ events: AdminEventRow[] }>('/api/admin/events', signal),
  eventOptions: (signal?: AbortSignal) => get<AdminEventOptions>('/api/admin/events/options', signal),
  event: (id: number, signal?: AbortSignal) => get<AdminEventDetail>(`/api/admin/events/${id}`, signal),
  createEvent: (body: { name: string; startsAt: string; entryKind: EntryKind }) => post<{ id: number; slug: string }>('/api/admin/events', body),
  updateEvent: (id: number, fields: Partial<EventFields>) => post(`/api/admin/events/${id}`, fields),
  addStage: (id: number, stage: StageSettings) => post(`/api/admin/events/${id}/stages`, stage),
  updateStage: (id: number, stageId: number, stage: StageSettings) => post(`/api/admin/events/${id}/stages/${stageId}`, stage),
  removeStage: (id: number, stageId: number) => post(`/api/admin/events/${id}/stages/${stageId}/remove`),
  reorderStages: (id: number, order: number[]) => post(`/api/admin/events/${id}/stages/order`, { order }),
  publishEvent: (id: number) => post(`/api/admin/events/${id}/publish`),
  openEventRegistration: (id: number) => post(`/api/admin/events/${id}/open-registration`),
  cancelEvent: (id: number, reason: string) => post(`/api/admin/events/${id}/cancel`, { reason }),
  /** `image` is base64 of the 1600 x 400 banner from toBannerImage, no data: prefix. */
  setEventBanner: (id: number, image: string) => post<{ bannerKey: string }>(`/api/admin/events/${id}/banner`, { image }),
  removeEventBanner: (id: number) => post(`/api/admin/events/${id}/banner/remove`),
```

- [ ] **Step 4: Write `web/src/eventFormat.ts`**

```ts
import type { EventStatus } from './api';

/** Event statuses as people read them. */
export const STATUS_LABEL: Record<EventStatus, string> = {
  draft: 'Draft', announced: 'Announced', registration: 'Registration open', checkin: 'Check-in',
  live: 'Live', finished: 'Finished', cancelled: 'Cancelled',
};

/** "in 2 days 3 h", "in 5 h 10 min", "in 42 min", or "starting now". A part
 *  minute rounds up, so it never says "in 0 min" before the start. */
export function untilText(iso: string, nowMs: number = Date.now()): string {
  const ms = Date.parse(iso) - nowMs;
  if (!Number.isFinite(ms) || ms <= 0) return 'starting now';
  const mins = Math.ceil(ms / 60_000);
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  if (days >= 2) return `in ${days} days ${hours} h`;
  if (mins >= 60) return `in ${days * 24 + hours} h ${mins % 60} min`;
  return `in ${mins} min`;
}

/** A stored UTC time in the viewer's own zone (Ruling 11). */
export function whenText(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** ISO UTC to the value a datetime-local input shows: the viewer's zone. */
export function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** A datetime-local value, read in the viewer's zone, as ISO UTC; null if it
 *  is not one. A value without a zone is local time to Date, which is the
 *  point. At the hour a clock goes back, the earlier of the two is taken. */
export function fromLocalInput(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
```

- [ ] **Step 5: Add the desk to the panel routes**

In `web/src/routes/admin/adminRoutes.ts`:

Replace `export type Desk = 'live' | 'people' | 'setup' | 'balance';` with

```ts
export type Desk = 'live' | 'people' | 'events' | 'setup' | 'balance';
```

In `DESKS`, after the People entry:

```ts
  { key: 'events', label: 'Events', path: '/admin/events' },
```

After `export const ticketUrl = ...`:

```ts
export const eventAdminUrl = (id: number | string): string => `/admin/events/${id}`;
```

Replace `deskItems` with

```ts
/** The desk strip: a moderator has Live and People (owner ruling 2026-09-28),
 *  and Events to read (tournaments plan T1a, Ruling 2). */
export const deskItems = (isAdmin: boolean) =>
  (isAdmin ? DESKS : DESKS.filter((d) => d.key === 'live' || d.key === 'people' || d.key === 'events'));
```

In `parseAdminPath`, right before `const people = (): AdminRoute => {`:

```ts
  // Events (tournaments plan T1a): the list, or one event by id. A moderator
  // reads the same screens; the screens leave out every control (Ruling 2).
  const events = (): AdminRoute => {
    if (a === '') return { desk: 'events', section: 'list', param: null };
    return TICKET.test(a) && b === '' ? { desk: 'events', section: 'event', param: a } : { ...NOWHERE, desk: 'events' };
  };

```

Replace the moderator branch and the admin People line:

```ts
  if (!opts.isAdmin) {
    if (desk === 'live' || desk === '') return { desk: 'live', section: 'board', param: null };
    if (desk === 'events') return events();
    return desk === 'people' ? people() : { desk: 'people', section: 'search', param: null };
  }
  if (desk === 'people') return people();
  if (desk === 'events') return events();
```

In `legacyRedirect`, replace the last two statements before `return null;` with

```ts
  const inPeople = path === '/admin/people' || path.startsWith('/admin/people/');
  const inEvents = path === '/admin/events' || path.startsWith('/admin/events/');
  if (!isAdmin && !(inPeople || inEvents || path.startsWith('/admin/live'))) return '/admin/people';
```

(keep the comment above `inPeople`), so a moderator's `/admin/events` is not sent to People.

- [ ] **Step 6: Write `web/src/routes/admin/events/EventsDesk.tsx`**

```tsx
import { useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { adminApi, type EntryKind } from '../../../api';
import { useFetch } from '../../../hooks/useFetch';
import { Empty, Panel } from '../../../components/bits';
import { STATUS_LABEL, fromLocalInput, whenText } from '../../../eventFormat';
import { useAction } from '../useAction';
import { eventAdminUrl } from '../adminRoutes';

/** The Events desk front page: a new draft (admins), and every event so far.
 *  A mod reads the list only (Ruling 2). */
export function EventsDesk({ canEdit }: { canEdit: boolean }) {
  const { route } = useLocation();
  const { data, reload } = useFetch((s) => adminApi.events(s), []);
  const { busy, error, run } = useAction(reload);
  const [name, setName] = useState('');
  const [start, setStart] = useState('');
  const [kind, setKind] = useState<EntryKind>('team');
  const [problem, setProblem] = useState<string | null>(null);

  const create = (e: Event) => {
    e.preventDefault();
    const startsAt = fromLocalInput(start);
    if (!startsAt) { setProblem('Pick a start time.'); return; }
    setProblem(null);
    void run(async () => {
      const r = await adminApi.createEvent({ name, startsAt, entryKind: kind });
      route(eventAdminUrl(r.id));
    });
  };

  return (
    <div class="stack">
      {canEdit && (
      <Panel>
        <h3>New event</h3>
        <p class="muted">It starts as a draft only admins can see. Add its stages, then publish it.</p>
        {(problem ?? error) && <p class="error" role="alert">{problem ?? error}</p>}
        <form class="admin-form admin-form--stack" onSubmit={create}>
          <label class="teamfield">Name
            <input aria-label="Name" value={name} maxLength={60} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
          </label>
          <label class="teamfield">Starts at (your time)
            <input aria-label="Starts at" type="datetime-local" value={start} onInput={(e) => setStart((e.target as HTMLInputElement).value)} />
          </label>
          <label class="teamfield">Entries
            <select aria-label="Entry kind" value={kind} onChange={(e) => setKind((e.target as HTMLSelectElement).value as EntryKind)}>
              <option value="team">Teams register</option>
              <option value="draft">Draft (individual signups)</option>
            </select>
          </label>
          <button class="btn" type="submit" disabled={busy || !name.trim()}>Create draft</button>
        </form>
      </Panel>
      )}
      <Panel>
        <h3>All events</h3>
        {!data ? <p class="muted">Loading...</p> : data.events.length === 0 ? <Empty>No events yet.</Empty> : (
          <ul class="admin-list">
            {data.events.map((ev) => (
              <li key={ev.id}>
                <a href={eventAdminUrl(ev.id)}><strong>{ev.name}</strong></a>{' '}
                <span class={`teamchip eventstatus eventstatus--${ev.status}`}>{STATUS_LABEL[ev.status]}</span>{' '}
                <span class="muted">· {whenText(ev.startsAt)} · {ev.stages} stage{ev.stages === 1 ? '' : 's'}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
```

- [ ] **Step 7: Mount the list in the panel**

In `web/src/routes/Admin.tsx`, add the import after `import { PlayerFile } from './admin/file/PlayerFile';`:

```tsx
import { EventsDesk } from './admin/events/EventsDesk';
```

In the `admin-body` div, right after the `r.desk === 'people' && r.section === 'ticket'` block:

```tsx
        {r.desk === 'events' && r.section === 'list' && <EventsDesk canEdit={isAdmin} />}
```

- [ ] **Step 8: Run the tests and typecheck**

Run: `npx vitest run web/src/eventFormat.test.ts web/src/routes/admin/adminRoutes.test.ts web/src/routes/admin/events/EventsDesk.test.tsx web/src/routes/admin.test.tsx && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 9: Commit**

```bash
git add web/src/api.ts web/src/eventFormat.ts web/src/eventFormat.test.ts web/src/routes/admin/adminRoutes.ts web/src/routes/admin/adminRoutes.test.ts web/src/routes/Admin.tsx web/src/routes/admin/events/EventsDesk.tsx web/src/routes/admin/events/EventsDesk.test.tsx
git commit -m "Events: the Events desk in the panel, the list for staff and the create form for admins"
```

---

### Task 8: The safe description formatter

**Files:**
- Create: `web/src/richText.ts`
- Create: `web/src/components/RichText.tsx`
- Test: `web/src/richText.test.ts`, `web/src/components/RichText.test.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks; Preact's `useMemo`.
- Produces (`web/src/richText.ts`, pure):
  - `type Inline = { kind: 'text'; text: string } | { kind: 'strong'; children: Inline[] } | { kind: 'em'; children: Inline[] } | { kind: 'link'; href: string; children: Inline[] } | { kind: 'br' }`
  - `type Block = { kind: 'heading'; level: 1 | 2 | 3; children: Inline[] } | { kind: 'paragraph'; children: Inline[] } | { kind: 'list'; ordered: boolean; items: Inline[][] }`
  - `RICH_TEXT_MAX = 4000`, `safeHref(raw: string): string | null`, `parseInline(src: string, depth?: number, inLink?: boolean): Inline[]`, `parseRichText(text: string): Block[]`.
- Produces (`web/src/components/RichText.tsx`): `RichText({ text, class }: { text: string; class?: string })`, a `div.richtext` (plus `class`) of `h3`/`h4`/`h5`, `p`, `ul`/`ol`, `strong`, `em`, `br` and `a target="_blank" rel="noopener noreferrer"`. Used by Task 9 (editor Preview and a mod's read-only details) and Task 10 (event page).

- [ ] **Step 1: Write the failing tests**

`web/src/richText.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseInline, parseRichText, safeHref, RICH_TEXT_MAX, type Block, type Inline } from './richText';

const t = (text: string): Inline => ({ kind: 'text', text });
const p = (...children: Inline[]): Block => ({ kind: 'paragraph', children });

describe('blocks', () => {
  it('reads headings of three levels, and a fourth # as text', () => {
    expect(parseRichText('# One\n## Two\n### Three\n#### Four')).toEqual([
      { kind: 'heading', level: 1, children: [t('One')] },
      { kind: 'heading', level: 2, children: [t('Two')] },
      { kind: 'heading', level: 3, children: [t('Three')] },
      p(t('#### Four')),
    ]);
    expect(parseRichText('#NoSpace')).toEqual([p(t('#NoSpace'))]);
  });

  it('joins lines into a paragraph with breaks, and a blank line starts the next', () => {
    expect(parseRichText('one\ntwo\r\n\r\nthree')).toEqual([p(t('one'), { kind: 'br' }, t('two')), p(t('three'))]);
    expect(parseRichText('')).toEqual([]);
    expect(parseRichText('\n\n  \n')).toEqual([]);
  });

  it('reads bullet and numbered lists, and a change of kind starts a new list', () => {
    expect(parseRichText('- a\n* b\n+ c\n1. d\n2) e\nafter')).toEqual([
      { kind: 'list', ordered: false, items: [[t('a')], [t('b')], [t('c')]] },
      { kind: 'list', ordered: true, items: [[t('d')], [t('e')]] },
      p(t('after')),
    ]);
    expect(parseRichText('intro\n- item')).toEqual([p(t('intro')), { kind: 'list', ordered: false, items: [[t('item')]] }]);
  });
});

describe('inlines', () => {
  it('reads bold and italic, nested either way', () => {
    expect(parseInline('**bold** and *it*')).toEqual([
      { kind: 'strong', children: [t('bold')] }, t(' and '), { kind: 'em', children: [t('it')] },
    ]);
    expect(parseInline('**a *b* c**')).toEqual([{ kind: 'strong', children: [t('a '), { kind: 'em', children: [t('b')] }, t(' c')] }]);
  });

  it('leaves unmatched or empty markers as text', () => {
    expect(parseInline('**open')).toEqual([t('**open')]);
    expect(parseInline('a * b')).toEqual([t('a * b')]);
    expect(parseInline('****')).toEqual([t('****')]);
    expect(parseInline('2 * 3 * 4')).toEqual([t('2 * 3 * 4')]);
  });

  it('links [text](url) and bare URLs, http and https only', () => {
    expect(parseInline('[Rules](https://example.com/r) here')).toEqual([
      { kind: 'link', href: 'https://example.com/r', children: [t('Rules')] }, t(' here'),
    ]);
    expect(parseInline('See https://example.com/a, then http://x.org.')).toEqual([
      t('See '), { kind: 'link', href: 'https://example.com/a', children: [t('https://example.com/a')] },
      t(', then '), { kind: 'link', href: 'http://x.org/', children: [t('http://x.org')] }, t('.'),
    ]);
    expect(parseInline('[**Big**](https://e.com)')).toEqual([{ kind: 'link', href: 'https://e.com/', children: [{ kind: 'strong', children: [t('Big')] }] }]);
  });

  it('shows any other link as the text it is', () => {
    for (const src of ['[x](javascript:alert(1))', '[x](JAVASCRIPT:alert(1))', '[x](data:text/html,hi)', '[x](//evil.com)', '[x](mailto:a@b.c)', '[x](https://)']) {
      expect(parseInline(src), src).toEqual([t(src)]);
    }
    expect(parseInline('javascript:alert(1)')).toEqual([t('javascript:alert(1)')]);
  });

  it('never puts a link inside a link', () => {
    expect(parseInline('[see https://a.com](https://b.com)')).toEqual([
      { kind: 'link', href: 'https://b.com/', children: [t('see https://a.com')] },
    ]);
  });
});

describe('hostile input', () => {
  it('keeps HTML as plain text', () => {
    expect(parseRichText('<script>alert(1)</script>\n<img src=x onerror=alert(1)>')).toEqual([
      p(t('<script>alert(1)</script>'), { kind: 'br' }, t('<img src=x onerror=alert(1)>')),
    ]);
  });

  it('stops nesting after a few levels and still keeps every character', () => {
    const deep = '*'.repeat(40) + 'x' + '*'.repeat(40);
    const text = (n: Inline[]): string => n.map((x) => (x.kind === 'text' ? x.text : x.kind === 'br' ? '\n' : text(x.children))).join('');
    const out = parseInline(deep);
    expect(text(out).replace(/\*/g, '')).toBe('x');
  });

  it('parses very long input quickly, and no further than the cap', () => {
    const nasty = ['*'.repeat(9000), '['.repeat(9000), '[a]('.repeat(3000), 'https://'.repeat(1500), '**a'.repeat(4000)];
    for (const src of nasty) {
      const start = performance.now();
      const blocks = parseRichText(src);
      expect(performance.now() - start).toBeLessThan(500);
      expect(JSON.stringify(blocks).length).toBeLessThan(RICH_TEXT_MAX * 20);
    }
  });

  it('accepts only http and https URLs as links', () => {
    expect(safeHref('https://example.com')).toBe('https://example.com/');
    expect(safeHref(' http://example.com/a?b=1 ')).toBe('http://example.com/a?b=1');
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('https://exa mple.com')).toBeNull();
    expect(safeHref('ftp://example.com')).toBeNull();
  });

  it('the formatter and its component never build HTML strings', () => {
    for (const f of ['./richText.ts', './components/RichText.tsx']) {
      const src = readFileSync(new URL(f, import.meta.url), 'utf8');
      expect(src, f).not.toMatch(/dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML/);
    }
  });
});
```

`web/src/components/RichText.test.tsx`:

```tsx
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import { RichText } from './RichText';

afterEach(cleanup);

describe('RichText', () => {
  it('renders each construct as its element', () => {
    const { container } = render(<RichText text={'# Title\n## Sub\n### Small\nA **b** *c*\nnext\n\n- one\n- two\n\n1. first\n\n[Site](https://riversidepug.com) https://example.com'} />);
    expect(container.querySelector('h3')?.textContent).toBe('Title');
    expect(container.querySelector('h4')?.textContent).toBe('Sub');
    expect(container.querySelector('h5')?.textContent).toBe('Small');
    expect(container.querySelector('strong')?.textContent).toBe('b');
    expect(container.querySelector('em')?.textContent).toBe('c');
    expect(container.querySelector('br')).toBeTruthy();
    expect([...container.querySelectorAll('ul li')].map((li) => li.textContent)).toEqual(['one', 'two']);
    expect([...container.querySelectorAll('ol li')].map((li) => li.textContent)).toEqual(['first']);
    const links = [...container.querySelectorAll('a')];
    expect(links.map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('target'), a.getAttribute('rel')])).toEqual([
      ['Site', 'https://riversidepug.com/', '_blank', 'noopener noreferrer'],
      ['https://example.com', 'https://example.com/', '_blank', 'noopener noreferrer'],
    ]);
  });

  it('shows tags, entities and other schemes as text, never as markup', () => {
    const { container } = render(<RichText text={'<img src=x onerror="alert(1)"> &amp; [x](javascript:alert(1)) <a href="https://e.com">y</a>'} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelectorAll('a')).toHaveLength(1);
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://e.com/');
    expect(container.textContent).toContain('<img src=x onerror="alert(1)"> &amp; [x](javascript:alert(1)) <a href="');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run web/src/richText.test.ts web/src/components/RichText.test.tsx`
Expected: FAIL with missing modules `./richText` and `./RichText`.

- [ ] **Step 3: Write `web/src/richText.ts`**

```ts
/**
 * A small, safe markdown subset for text staff write and everyone reads (an
 * event's description, tournaments plan T1a Ruling 1). Pure: it turns text
 * into a tree of blocks and inlines, and web/src/components/RichText.tsx
 * turns the tree into Preact elements. Nothing here ever produces an HTML
 * string, so whatever the text holds (tags, entities, script) is shown as the
 * characters it is.
 *
 * Supported: # ## ### headings; paragraphs, a single line break kept as a
 * break; **bold**, *italic*; "- " / "* " / "+ " and "1. " / "1) " lists (flat);
 * [text](url) and bare URLs, both only for http:// and https://. Anything
 * else, including a link to any other scheme, is plain text.
 */

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'em'; children: Inline[] }
  | { kind: 'link'; href: string; children: Inline[] }
  | { kind: 'br' };

export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3; children: Inline[] }
  | { kind: 'paragraph'; children: Inline[] }
  | { kind: 'list'; ordered: boolean; items: Inline[][] };

/** The server caps a description at 4000 characters; the parser holds to the
 *  same, so nothing longer is ever worked through on a page. */
export const RICH_TEXT_MAX = 4000;
/** How deep **bold** and *italic* may nest before the rest is plain text. */
const MAX_DEPTH = 4;

/** An http or https URL as the browser would resolve it, or null. */
export function safeHref(raw: string): string | null {
  const url = raw.trim();
  if (!/^https?:\/\/\S+$/i.test(url)) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/** Sticky: tried at one position, never searched for. */
const BARE_URL = /https?:\/\/[^\s<>"]+/iy;
/** Punctuation that ends a sentence rather than the URL it follows. */
const TRAILING = /[.,;:!?)\]'"]+$/;

function pushText(out: Inline[], text: string): void {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.kind === 'text') last.text += text;
  else out.push({ kind: 'text', text });
}

/** Inline markup in one line or one list item. `inLink` keeps link text from
 *  holding another link. */
export function parseInline(src: string, depth = 0, inLink = false): Inline[] {
  const out: Inline[] = [];
  if (depth > MAX_DEPTH) {
    pushText(out, src);
    return out;
  }
  let i = 0;
  while (i < src.length) {
    if (src.startsWith('**', i)) {
      const end = src.indexOf('**', i + 2);
      if (end > i + 2) {
        out.push({ kind: 'strong', children: parseInline(src.slice(i + 2, end), depth + 1, inLink) });
        i = end + 2;
        continue;
      }
      pushText(out, '**');
      i += 2;
      continue;
    }
    if (src[i] === '*') {
      const end = src.indexOf('*', i + 1);
      if (end > i + 1 && src[i + 1] !== ' ') {
        out.push({ kind: 'em', children: parseInline(src.slice(i + 1, end), depth + 1, inLink) });
        i = end + 1;
        continue;
      }
      pushText(out, '*');
      i += 1;
      continue;
    }
    if (!inLink && src[i] === '[') {
      const mid = src.indexOf('](', i + 1);
      const end = mid < 0 ? -1 : src.indexOf(')', mid + 2);
      if (mid > i + 1 && end > mid + 2 && !src.slice(i + 1, mid).includes('\n')) {
        const href = safeHref(src.slice(mid + 2, end));
        if (href) {
          out.push({ kind: 'link', href, children: parseInline(src.slice(i + 1, mid), depth + 1, true) });
        } else {
          pushText(out, src.slice(i, end + 1));
        }
        i = end + 1;
        continue;
      }
    }
    if (!inLink) {
      BARE_URL.lastIndex = i;
      const m = BARE_URL.exec(src);
      if (m) {
        const url = m[0].replace(TRAILING, '');
        const href = safeHref(url);
        if (href) {
          out.push({ kind: 'link', href, children: [{ kind: 'text', text: url }] });
          i += url.length;
          continue;
        }
      }
    }
    // Plain text up to the next character that could start markup.
    let j = i + 1;
    while (j < src.length && !'*[h'.includes(src[j]!)) j++;
    pushText(out, src.slice(i, j));
    i = j;
  }
  return out;
}

const HEADING = /^(#{1,3})\s+(.+)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d{1,9}[.)]\s+(.*)$/;

/** The whole text as blocks. Lines are joined into paragraphs, a single line
 *  break kept as a break; a blank line, a heading or a list ends one. */
export function parseRichText(text: string): Block[] {
  const lines = text.slice(0, RICH_TEXT_MAX).replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: Inline[][] } | null = null;
  const flush = () => {
    if (para.length > 0) {
      const children: Inline[] = [];
      para.forEach((line, n) => {
        if (n > 0) children.push({ kind: 'br' });
        children.push(...parseInline(line));
      });
      blocks.push({ kind: 'paragraph', children });
      para = [];
    }
    if (list) {
      blocks.push({ kind: 'list', ordered: list.ordered, items: list.items });
      list = null;
    }
  };
  for (const line of lines) {
    if (line.trim() === '') { flush(); continue; }
    const h = HEADING.exec(line);
    if (h) {
      flush();
      blocks.push({ kind: 'heading', level: h[1]!.length as 1 | 2 | 3, children: parseInline(h[2]!.trim()) });
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    const item = bullet ?? numbered;
    if (item) {
      const ordered = numbered !== null;
      if (para.length > 0 || (list && list.ordered !== ordered)) flush();
      if (!list) list = { ordered, items: [] };
      list.items.push(parseInline(item[1]!));
      continue;
    }
    if (list) flush();
    para.push(line.trim());
  }
  flush();
  return blocks;
}
```

- [ ] **Step 4: Write `web/src/components/RichText.tsx`**

```tsx
import { useMemo } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { parseRichText, type Block, type Inline } from '../richText';

function inline(nodes: Inline[]): ComponentChildren[] {
  return nodes.map((n, i) => {
    switch (n.kind) {
      case 'text': return n.text;
      case 'br': return <br key={i} />;
      case 'strong': return <strong key={i}>{inline(n.children)}</strong>;
      case 'em': return <em key={i}>{inline(n.children)}</em>;
      case 'link': return <a key={i} href={n.href} target="_blank" rel="noopener noreferrer">{inline(n.children)}</a>;
    }
  });
}

/** Headings sit under the panel's own h3, so # is an h3, ## an h4, ### an h5. */
function block(b: Block, i: number) {
  if (b.kind === 'heading') {
    const Tag = (['h3', 'h4', 'h5'] as const)[b.level - 1]!;
    return <Tag key={i} class={`richtext__h${b.level}`}>{inline(b.children)}</Tag>;
  }
  if (b.kind === 'list') {
    const items = b.items.map((it, n) => <li key={n}>{inline(it)}</li>);
    return b.ordered ? <ol key={i}>{items}</ol> : <ul key={i}>{items}</ul>;
  }
  return <p key={i}>{inline(b.children)}</p>;
}

/** Text in the safe markdown subset (web/src/richText.ts), as elements.
 *  Never sets HTML: every string goes in as a text child. */
export function RichText({ text, class: cls }: { text: string; class?: string }) {
  const blocks = useMemo(() => parseRichText(text), [text]);
  return <div class={cls ? `richtext ${cls}` : 'richtext'}>{blocks.map(block)}</div>;
}
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `npx vitest run web/src/richText.test.ts web/src/components/RichText.test.tsx && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add web/src/richText.ts web/src/richText.test.ts web/src/components/RichText.tsx web/src/components/RichText.test.tsx
git commit -m "Events: a safe markdown subset for descriptions, parsed to a tree and rendered as Preact elements only"
```

---

### Task 9: The event editor (fields with Preview, banner, stages, lifecycle, history; read only for mods)

**Files:**
- Create: `web/src/routes/admin/events/stageDraft.ts`
- Create: `web/src/routes/admin/events/StageForm.tsx`
- Create: `web/src/routes/admin/events/EventFieldsForm.tsx`
- Create: `web/src/routes/admin/events/EventEditor.tsx`
- Create: `web/src/eventBanner.ts`
- Modify: `web/src/routes/Admin.tsx` (import and the `event` section)
- Test: `web/src/routes/admin/events/stageDraft.test.ts`, `web/src/routes/admin/events/EventEditor.test.tsx`

**Interfaces:**
- Consumes: Task 7 `adminApi` event calls (banner ones included) and types, `bannerUrl`, `STATUS_LABEL`, `whenText`, `toLocalInput`, `fromLocalInput`; Task 8 `RichText`; `useFetch` (`web/src/hooks/useFetch.ts`); `useAction(reload)` and `fmtTime` (`web/src/routes/admin/useAction.ts`); `Panel`, `Empty` (`web/src/components/bits.tsx`).
- Produces:
  - `stageDraft.ts`: `interface StageDraft { type: StageType; thirdPlace: boolean; grandFinalReset: boolean; groups: number; rounds: number; weeks: number; matchesPerWeek: number; pairing: 'swiss' | 'round_robin'; rulesetId: number; gameConfig: string; campaignPool: string[]; vetoType: VetoType; chapters: number | null; scheduling: Scheduling; advanceCount: number | null }`, `draftFrom(s: StageSettings | null, o: AdminEventOptions): StageDraft`, `configOf(d: StageDraft): StageConfig`, `settingsFrom(d: StageDraft): StageSettings`.
  - `StageForm({ options, initial, busy, onSave, onCancel }: { options: AdminEventOptions; initial: StageSettings | null; busy: boolean; onSave: (s: StageSettings) => void; onCancel: () => void })`.
  - `EventFieldsForm({ fields, status, busy, onSave }: { fields: EventFields; status: EventStatus; busy: boolean; onSave: (f: EventFields) => void })`, with a Preview / Edit toggle over the description that renders it through `RichText`.
  - `EventEditor({ id, canEdit }: { id: number; canEdit: boolean })`: with `canEdit` false (a mod) it shows the event's details (through `RichText` for the description), banner, stages and history and no button, input or form at all.
  - `web/src/eventBanner.ts`: `toBannerImage(file: File): Promise<string>` (base64 of a 1600 x 400 WebP, or PNG on a browser that cannot write WebP).

- [ ] **Step 1: Write the failing tests**

`web/src/routes/admin/events/stageDraft.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { AdminEventOptions, StageSettings } from '../../../api';
import { configOf, draftFrom, settingsFrom } from './stageDraft';

const OPTIONS: AdminEventOptions = {
  campaigns: [{ slug: 'no_mercy', name: 'No Mercy' }, { slug: 'dead_air', name: 'Dead Air' }],
  defaultPool: ['no_mercy', 'dead_air'], rulesets: [{ id: 1, name: 'PUG' }, { id: 2, name: 'Standard Cup' }], defaultRulesetId: 2,
  gameConfigs: [{ key: 'standard', label: 'Standard' }],
  defaults: {
    eligibility: { minPugs: 5, requireDiscord: true, srFloor: null, srCeiling: null },
    checkin: { enabled: true, opensMinutes: 60, closesMinutes: 15 },
    roster: { starters: 4, maxSubs: 2, lock: { kind: 'none' }, maxAdditions: null },
  },
};

describe('stage drafts', () => {
  it('a new stage starts as single elimination on the default ruleset and the site pool', () => {
    expect(settingsFrom(draftFrom(null, OPTIONS))).toEqual({
      type: 'single_elim', config: { thirdPlace: false }, rulesetId: 2, gameConfig: 'standard', campaignPool: ['no_mercy', 'dead_air'],
      vetoType: 'ban_to_one', chapters: null, scheduling: 'rolling', advanceCount: null,
    });
  });

  it('round-trips a saved stage, and sends only the chosen type settings', () => {
    const league: StageSettings = {
      type: 'league', config: { weeks: 8, matchesPerWeek: 2, pairing: 'round_robin' }, rulesetId: 1, gameConfig: 'standard',
      campaignPool: ['dead_air'], vetoType: 'home_away', chapters: 3, scheduling: 'window', advanceCount: 4,
    };
    expect(settingsFrom(draftFrom(league, OPTIONS))).toEqual(league);
    const d = { ...draftFrom(league, OPTIONS), type: 'swiss' as const, scheduling: 'rolling' as const };
    expect(configOf(d)).toEqual({ rounds: 4 });
  });

  it('a league is always sent as window scheduled', () => {
    const d = { ...draftFrom(null, OPTIONS), type: 'league' as const, scheduling: 'rolling' as const };
    expect(settingsFrom(d).scheduling).toBe('window');
  });
});
```

`web/src/routes/admin/events/EventEditor.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { AdminEventDetail, AdminEventOptions, AdminEventStage, EventFields } from '../../../api';

const { mockAdmin, mockConfirm } = vi.hoisted(() => ({
  mockAdmin: {
    event: vi.fn(), eventOptions: vi.fn(), updateEvent: vi.fn(), addStage: vi.fn(), updateStage: vi.fn(), removeStage: vi.fn(),
    reorderStages: vi.fn(), publishEvent: vi.fn(), openEventRegistration: vi.fn(), cancelEvent: vi.fn(),
    setEventBanner: vi.fn(), removeEventBanner: vi.fn(),
  },
  mockConfirm: vi.fn(),
}));
vi.mock('../../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api')>();
  return { ...actual, adminApi: { ...actual.adminApi, ...mockAdmin } };
});
vi.mock('../../../components/Confirm', () => ({ confirm: mockConfirm }));
vi.mock('../../../eventBanner', () => ({ toBannerImage: vi.fn(async () => 'BASE64') }));
const { EventEditor } = await import('./EventEditor');
const { ApiError } = await import('../../../api');

const OPTIONS: AdminEventOptions = {
  campaigns: [{ slug: 'no_mercy', name: 'No Mercy' }, { slug: 'dead_air', name: 'Dead Air' }, { slug: 'death_toll', name: 'Death Toll' }],
  defaultPool: ['no_mercy', 'dead_air'], rulesets: [{ id: 2, name: 'Standard Cup' }], defaultRulesetId: 2,
  gameConfigs: [{ key: 'standard', label: 'Standard' }],
  defaults: {
    eligibility: { minPugs: 5, requireDiscord: true, srFloor: null, srCeiling: null },
    checkin: { enabled: true, opensMinutes: 60, closesMinutes: 15 },
    roster: { starters: 4, maxSubs: 2, lock: { kind: 'none' }, maxAdditions: null },
  },
};
const FIELDS: EventFields = {
  name: 'Riverside Cup', startsAt: '2026-10-10T20:00:00.000Z', entryKind: 'team', official: true, teamCap: null, description: '',
  eligibility: OPTIONS.defaults.eligibility, checkin: OPTIONS.defaults.checkin, roster: OPTIONS.defaults.roster,
};
const stage = (id: number, ordinal: number, swiss: boolean): AdminEventStage => ({
  id, ordinal, rulesSnapshotted: false,
  summary: swiss ? 'Swiss, 4 rounds, top 8 advance' : 'Single elimination',
  settings: {
    type: swiss ? 'swiss' : 'single_elim', config: swiss ? { rounds: 4 } : { thirdPlace: false }, rulesetId: 2, gameConfig: 'standard',
    campaignPool: ['no_mercy', 'dead_air'], vetoType: 'ban_to_one', chapters: null, scheduling: 'rolling', advanceCount: swiss ? 8 : null,
  },
});
const detail = (over: Partial<AdminEventDetail> = {}): AdminEventDetail => ({
  id: 3, slug: 'riverside-cup', status: 'draft', fields: FIELDS, bannerKey: null, cancelReason: null,
  createdAt: '2026-10-01T12:00:00.000Z', updatedAt: '2026-10-01T12:00:00.000Z',
  stages: [stage(10, 1, true), stage(11, 2, false)],
  log: [{ at: '2026-10-01T12:00:00.000Z', actorName: 'boss', action: 'created', detail: {} }],
  ...over,
});

afterEach(cleanup);
beforeEach(() => {
  for (const f of [...Object.values(mockAdmin), mockConfirm]) f.mockReset();
  mockAdmin.eventOptions.mockResolvedValue(OPTIONS);
  mockConfirm.mockResolvedValue(true);
  for (const f of [mockAdmin.updateEvent, mockAdmin.addStage, mockAdmin.updateStage, mockAdmin.removeStage, mockAdmin.reorderStages,
    mockAdmin.publishEvent, mockAdmin.openEventRegistration, mockAdmin.cancelEvent, mockAdmin.setEventBanner,
    mockAdmin.removeEventBanner]) f.mockResolvedValue({ ok: true });
});

describe('EventEditor', () => {
  it('shows a draft with its stages, history, Publish and no Open registration', async () => {
    mockAdmin.event.mockResolvedValue(detail());
    render(<EventEditor id={3} canEdit />);
    expect(await screen.findByText('Swiss, 4 rounds, top 8 advance')).toBeTruthy();
    expect(screen.getByText('Single elimination')).toBeTruthy();
    expect(screen.getByText(/boss · Created/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Publish' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open registration' })).toBeNull();
    expect((screen.getByLabelText('Entry kind') as HTMLSelectElement).disabled).toBe(false);
  });

  it('Publish asks first, then publishes and reloads', async () => {
    mockAdmin.event.mockResolvedValue(detail());
    render(<EventEditor id={3} canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(mockAdmin.publishEvent).toHaveBeenCalledWith(3));
    expect(mockConfirm).toHaveBeenCalled();
    await waitFor(() => expect(mockAdmin.event).toHaveBeenCalledTimes(2));
  });

  it('moves a stage up by sending the swapped order', async () => {
    mockAdmin.event.mockResolvedValue(detail());
    render(<EventEditor id={3} canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'Move stage 2 up' }));
    await waitFor(() => expect(mockAdmin.reorderStages).toHaveBeenCalledWith(3, [11, 10]));
    expect((screen.getByRole('button', { name: 'Move stage 1 up' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('adds a stage from the form, starting from the site pool', async () => {
    mockAdmin.event.mockResolvedValue(detail());
    render(<EventEditor id={3} canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add stage' }));
    expect((screen.getByLabelText('No Mercy') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Death Toll') as HTMLInputElement).checked).toBe(false);
    fireEvent.change(screen.getByLabelText('Stage type'), { target: { value: 'swiss' } });
    fireEvent.input(screen.getByLabelText('Rounds'), { target: { value: '5' } });
    fireEvent.click(screen.getByLabelText('Death Toll'));
    fireEvent.input(screen.getByLabelText('Advance count'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save stage' }));
    await waitFor(() => expect(mockAdmin.addStage).toHaveBeenCalledWith(3, {
      type: 'swiss', config: { rounds: 5 }, rulesetId: 2, gameConfig: 'standard', campaignPool: ['no_mercy', 'dead_air', 'death_toll'],
      vetoType: 'ban_to_one', chapters: null, scheduling: 'rolling', advanceCount: 4,
    }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save stage' })).toBeNull());
  });

  it('keeps the stage form open when the server refuses it', async () => {
    mockAdmin.event.mockResolvedValue(detail());
    mockAdmin.addStage.mockRejectedValue(new ApiError(400, 'An advance count is 2 to 128 teams.'));
    render(<EventEditor id={3} canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add stage' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save stage' }));
    expect(await screen.findByText('An advance count is 2 to 128 teams.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save stage' })).toBeTruthy();
  });

  it('saves edited fields with the start time unchanged', async () => {
    mockAdmin.event.mockResolvedValue(detail());
    render(<EventEditor id={3} canEdit />);
    fireEvent.input(await screen.findByLabelText('Team cap'), { target: { value: '16' } });
    fireEvent.input(screen.getByLabelText('Description'), { target: { value: 'Line one\nLine two' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save event' }));
    await waitFor(() => expect(mockAdmin.updateEvent).toHaveBeenCalledWith(3, { ...FIELDS, teamCap: 16, description: 'Line one\nLine two' }));
  });

  it('an announced team event offers Open registration and locks the entry kind; a draft-kind one does not offer it', async () => {
    mockAdmin.event.mockResolvedValue(detail({ status: 'announced' }));
    const first = render(<EventEditor id={3} canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open registration' }));
    await waitFor(() => expect(mockAdmin.openEventRegistration).toHaveBeenCalledWith(3));
    expect((screen.getByLabelText('Entry kind') as HTMLSelectElement).disabled).toBe(true);
    first.unmount();
    mockAdmin.event.mockResolvedValue(detail({ status: 'announced', fields: { ...FIELDS, entryKind: 'draft' } }));
    render(<EventEditor id={3} canEdit />);
    await screen.findByText('Swiss, 4 rounds, top 8 advance');
    expect(screen.queryByRole('button', { name: 'Open registration' })).toBeNull();
  });

  it('cancels with the reason typed, after asking', async () => {
    mockAdmin.event.mockResolvedValue(detail({ status: 'registration' }));
    render(<EventEditor id={3} canEdit />);
    fireEvent.input(await screen.findByLabelText('Cancel reason'), { target: { value: 'Not enough teams' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel event' }));
    await waitFor(() => expect(mockAdmin.cancelEvent).toHaveBeenCalledWith(3, 'Not enough teams'));
    expect(mockConfirm).toHaveBeenCalled();
  });

  it('a live event has no stage controls, no field form and no cancel reason box beyond Cancel', async () => {
    mockAdmin.event.mockResolvedValue(detail({ status: 'live' }));
    render(<EventEditor id={3} canEdit />);
    await screen.findByText('Swiss, 4 rounds, top 8 advance');
    expect(screen.queryByRole('button', { name: 'Add stage' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Move stage 2 up' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save event' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Cancel event' })).toBeTruthy();
  });

  it('a cancelled event shows its reason and nothing to press', async () => {
    mockAdmin.event.mockResolvedValue(detail({ status: 'cancelled', cancelReason: 'Not enough teams' }));
    render(<EventEditor id={3} canEdit />);
    expect(await screen.findByText('Cancelled: Not enough teams')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel event' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
  });

  it('previews the description with the same formatter the event page uses', async () => {
    mockAdmin.event.mockResolvedValue(detail());
    render(<EventEditor id={3} canEdit />);
    fireEvent.input(await screen.findByLabelText('Description'), { target: { value: '**Bring snacks**' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(screen.getByText('Bring snacks').tagName).toBe('STRONG');
    expect(screen.queryByLabelText('Description')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value).toBe('**Bring snacks**');
  });

  it('uploads a banner from the picked file, and removes one after asking', async () => {
    mockAdmin.event.mockResolvedValue(detail());
    const { rerender } = render(<EventEditor id={3} canEdit />);
    const input = await screen.findByLabelText('Banner');
    fireEvent.change(input, { target: { files: [new File(['x'], 'b.jpg', { type: 'image/jpeg' })] } });
    await waitFor(() => expect(mockAdmin.setEventBanner).toHaveBeenCalledWith(3, 'BASE64'));
    mockAdmin.event.mockResolvedValue(detail({ bannerKey: 'e'.repeat(64) }));
    rerender(<EventEditor id={4} canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove banner' }));
    await waitFor(() => expect(mockAdmin.removeEventBanner).toHaveBeenCalledWith(4));
    expect(mockConfirm).toHaveBeenCalled();
  });

  it('a mod reads the event, its banner, stages and history, with no control anywhere', async () => {
    mockAdmin.event.mockResolvedValue(detail({ bannerKey: 'e'.repeat(64), fields: { ...FIELDS, description: '*Team event*' } }));
    const { container } = render(<EventEditor id={3} canEdit={false} />);
    expect(await screen.findByText('Swiss, 4 rounds, top 8 advance')).toBeTruthy();
    expect(screen.getByText('Read only: admins run events.')).toBeTruthy();
    expect(screen.getByText(/boss · Created/)).toBeTruthy();
    expect(screen.getByText('Team event').tagName).toBe('EM');
    expect(container.querySelector('img.eventbanner')).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(container.querySelectorAll('input, select, textarea')).toHaveLength(0);
  });

  it('says so for an event that does not exist', async () => {
    mockAdmin.event.mockRejectedValue(new ApiError(404, 'No such event.'));
    render(<EventEditor id={99} canEdit />);
    expect(await screen.findByText('No such event.')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run web/src/routes/admin/events/stageDraft.test.ts web/src/routes/admin/events/EventEditor.test.tsx`
Expected: FAIL with missing modules `./stageDraft` and `./EventEditor`.

- [ ] **Step 3: Write `web/src/routes/admin/events/stageDraft.ts`**

```ts
import type { AdminEventOptions, Scheduling, StageConfig, StageConfigs, StageSettings, StageType, VetoType } from '../../../api';

/**
 * The stage form's own state: every type's settings at once, so switching the
 * type back and forth keeps what was typed. settingsFrom sends only the
 * chosen type's settings; the server (src/events/validate.ts) is the judge of
 * every range.
 */
export interface StageDraft {
  type: StageType;
  thirdPlace: boolean; grandFinalReset: boolean; groups: number; rounds: number;
  weeks: number; matchesPerWeek: number; pairing: 'swiss' | 'round_robin';
  rulesetId: number; gameConfig: string; campaignPool: string[]; vetoType: VetoType;
  chapters: number | null; scheduling: Scheduling; advanceCount: number | null;
}

type AnyConfig = Partial<StageConfigs['single_elim'] & StageConfigs['double_elim'] & StageConfigs['round_robin'] & StageConfigs['swiss'] & StageConfigs['league']>;

export function draftFrom(s: StageSettings | null, o: AdminEventOptions): StageDraft {
  const c = (s?.config ?? {}) as AnyConfig;
  return {
    type: s?.type ?? 'single_elim',
    thirdPlace: c.thirdPlace ?? false, grandFinalReset: c.grandFinalReset ?? true, groups: c.groups ?? 1, rounds: c.rounds ?? 4,
    weeks: c.weeks ?? 6, matchesPerWeek: c.matchesPerWeek ?? 1, pairing: c.pairing ?? 'swiss',
    rulesetId: s?.rulesetId ?? o.defaultRulesetId ?? o.rulesets[0]?.id ?? 0,
    gameConfig: s?.gameConfig ?? 'standard',
    campaignPool: s ? [...s.campaignPool] : [...o.defaultPool],
    vetoType: s?.vetoType ?? 'ban_to_one',
    chapters: s?.chapters ?? null,
    scheduling: s?.scheduling ?? 'rolling',
    advanceCount: s?.advanceCount ?? null,
  };
}

export function configOf(d: StageDraft): StageConfig {
  switch (d.type) {
    case 'single_elim': return { thirdPlace: d.thirdPlace };
    case 'double_elim': return { grandFinalReset: d.grandFinalReset };
    case 'round_robin': return { groups: d.groups };
    case 'swiss': return { rounds: d.rounds };
    case 'league': return { weeks: d.weeks, matchesPerWeek: d.matchesPerWeek, pairing: d.pairing };
  }
}

export function settingsFrom(d: StageDraft): StageSettings {
  return {
    type: d.type, config: configOf(d), rulesetId: d.rulesetId, gameConfig: d.gameConfig, campaignPool: d.campaignPool,
    vetoType: d.vetoType, chapters: d.chapters, scheduling: d.type === 'league' ? 'window' : d.scheduling, advanceCount: d.advanceCount,
  };
}
```

- [ ] **Step 4: Write `web/src/routes/admin/events/StageForm.tsx`**

```tsx
import { useState } from 'preact/hooks';
import type { AdminEventOptions, Scheduling, StageSettings, StageType, VetoType } from '../../../api';
import { draftFrom, settingsFrom, type StageDraft } from './stageDraft';

const TYPES: [StageType, string][] = [
  ['single_elim', 'Single elimination'], ['double_elim', 'Double elimination'], ['round_robin', 'Round robin'], ['swiss', 'Swiss'], ['league', 'League'],
];
const VETOES: [VetoType, string][] = [
  ['ban_to_one', 'Ban to one (Bo1)'], ['home_away', 'Home and away (Bo2 aggregate)'], ['pick_ban', 'Pick and ban (Bo3, exactly 7 campaigns)'],
];
const num = (e: Event): number => Number((e.target as HTMLInputElement).value);
const numOrNull = (e: Event): number | null => {
  const v = (e.target as HTMLInputElement).value.trim();
  return v === '' ? null : Number(v);
};
const pick = (e: Event): string => (e.target as HTMLSelectElement).value;

/** One stage's settings. Saving hands the settings up; the editor sends them. */
export function StageForm({ options, initial, busy, onSave, onCancel }: {
  options: AdminEventOptions; initial: StageSettings | null; busy: boolean; onSave: (s: StageSettings) => void; onCancel: () => void;
}) {
  const [d, setD] = useState<StageDraft>(() => draftFrom(initial, options));
  const set = (patch: Partial<StageDraft>) => setD((x) => ({ ...x, ...patch }));
  const toggle = (slug: string) =>
    set({ campaignPool: d.campaignPool.includes(slug) ? d.campaignPool.filter((s) => s !== slug) : [...d.campaignPool, slug] });

  return (
    <form class="admin-form admin-form--stack" onSubmit={(e) => { e.preventDefault(); onSave(settingsFrom(d)); }}>
      <label class="teamfield">Stage type
        <select aria-label="Stage type" value={d.type} onChange={(e) => {
          const type = pick(e) as StageType;
          set({ type, scheduling: type === 'league' ? 'window' : d.scheduling });
        }}>
          {TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </label>
      {d.type === 'single_elim' && (
        <label><input type="checkbox" aria-label="Third-place match" checked={d.thirdPlace} onChange={() => set({ thirdPlace: !d.thirdPlace })} /> Third-place match</label>
      )}
      {d.type === 'double_elim' && (
        <label><input type="checkbox" aria-label="Grand final reset" checked={d.grandFinalReset} onChange={() => set({ grandFinalReset: !d.grandFinalReset })} /> Grand final reset</label>
      )}
      {d.type === 'round_robin' && (
        <label class="teamfield">Groups<input aria-label="Groups" type="number" min={1} max={8} value={d.groups} onInput={(e) => set({ groups: num(e) })} /></label>
      )}
      {d.type === 'swiss' && (
        <label class="teamfield">Rounds<input aria-label="Rounds" type="number" min={1} max={9} value={d.rounds} onInput={(e) => set({ rounds: num(e) })} /></label>
      )}
      {d.type === 'league' && (
        <>
          <label class="teamfield">Weeks<input aria-label="Weeks" type="number" min={1} max={12} value={d.weeks} onInput={(e) => set({ weeks: num(e) })} /></label>
          <label class="teamfield">Matches a week<input aria-label="Matches a week" type="number" min={1} max={3} value={d.matchesPerWeek} onInput={(e) => set({ matchesPerWeek: num(e) })} /></label>
          <label class="teamfield">Pairing
            <select aria-label="League pairing" value={d.pairing} onChange={(e) => set({ pairing: pick(e) as 'swiss' | 'round_robin' })}>
              <option value="swiss">Swiss by record</option>
              <option value="round_robin">Full round robin over the weeks</option>
            </select>
          </label>
        </>
      )}
      <label class="teamfield">Ruleset
        <select aria-label="Ruleset" value={String(d.rulesetId)} onChange={(e) => set({ rulesetId: Number(pick(e)) })}>
          {options.rulesets.map((r) => <option key={r.id} value={String(r.id)}>{r.name}</option>)}
        </select>
      </label>
      <label class="teamfield">Game config
        <select aria-label="Game config" value={d.gameConfig} onChange={(e) => set({ gameConfig: pick(e) })}>
          {options.gameConfigs.map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
        </select>
      </label>
      <label class="teamfield">Veto
        <select aria-label="Veto" value={d.vetoType} onChange={(e) => set({ vetoType: pick(e) as VetoType })}>
          {VETOES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </label>
      <fieldset class="bookform__fieldset">
        <legend class="teamsub">Campaign pool ({d.campaignPool.length} of up to 12)</legend>
        {options.campaigns.map((c) => (
          <label key={c.slug}>
            <input type="checkbox" aria-label={c.name} checked={d.campaignPool.includes(c.slug)} onChange={() => toggle(c.slug)} /> {c.name}
          </label>
        ))}
      </fieldset>
      <label>
        <input type="checkbox" aria-label="Every chapter but the finale" checked={d.chapters === null}
          onChange={() => set({ chapters: d.chapters === null ? 3 : null })} /> Every chapter but the finale
      </label>
      {d.chapters !== null && (
        <label class="teamfield">Chapters<input aria-label="Chapters" type="number" min={1} max={5} value={d.chapters} onInput={(e) => set({ chapters: num(e) })} /></label>
      )}
      {d.type !== 'league' && (
        <label class="teamfield">Scheduling
          <select aria-label="Scheduling" value={d.scheduling} onChange={(e) => set({ scheduling: pick(e) as Scheduling })}>
            <option value="rolling">Rolling (one night)</option>
            <option value="window">Windows (long event)</option>
          </select>
        </label>
      )}
      <label class="teamfield">Teams that advance (blank on the last stage)
        <input aria-label="Advance count" type="number" min={2} max={128} value={d.advanceCount ?? ''} onInput={(e) => set({ advanceCount: numOrNull(e) })} />
      </label>
      <span class="inlinerow">
        <button class="btn" type="submit" disabled={busy}>Save stage</button>
        <button class="btn btn--ghost" type="button" onClick={onCancel}>Cancel</button>
      </span>
    </form>
  );
}
```

- [ ] **Step 5: Write `web/src/routes/admin/events/EventFieldsForm.tsx`**

```tsx
import { useState } from 'preact/hooks';
import type { EntryKind, EventFields, EventStatus, RosterLock } from '../../../api';
import { fromLocalInput, toLocalInput } from '../../../eventFormat';
import { RichText } from '../../../components/RichText';

const val = (e: Event): string => (e.target as HTMLInputElement).value;
const numOrNull = (v: string): number | null => (v.trim() === '' ? null : Number(v));

/** The event's own settings. Times are typed in the admin's zone and sent as
 *  UTC (Ruling 11); the server checks every range. Keyed by the event's
 *  updatedAt in the editor, so a save that reloads starts it afresh. */
export function EventFieldsForm({ fields, status, busy, onSave }: {
  fields: EventFields; status: EventStatus; busy: boolean; onSave: (f: EventFields) => void;
}) {
  const [f, setF] = useState<EventFields>(fields);
  const [start, setStart] = useState(toLocalInput(fields.startsAt));
  const [lockAt, setLockAt] = useState(fields.roster.lock.kind === 'at' ? toLocalInput(fields.roster.lock.at) : '');
  const [problem, setProblem] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const set = (patch: Partial<EventFields>) => setF((x) => ({ ...x, ...patch }));
  const elig = (patch: Partial<EventFields['eligibility']>) => set({ eligibility: { ...f.eligibility, ...patch } });
  const checkin = (patch: Partial<EventFields['checkin']>) => set({ checkin: { ...f.checkin, ...patch } });
  const roster = (patch: Partial<EventFields['roster']>) => set({ roster: { ...f.roster, ...patch } });
  const lock = f.roster.lock;
  const setLockKind = (kind: RosterLock['kind']) => {
    if (kind === 'at' && !lockAt) setLockAt(toLocalInput(f.startsAt));
    roster({ lock: kind === 'none' ? { kind } : kind === 'at' ? { kind, at: f.startsAt } : { kind, stage: 1, round: 1 } });
  };

  const submit = (e: Event) => {
    e.preventDefault();
    const startsAt = fromLocalInput(start);
    if (!startsAt) { setProblem('Pick a start time.'); return; }
    let rosterLock: RosterLock = lock;
    if (lock.kind === 'at') {
      const at = fromLocalInput(lockAt);
      if (!at) { setProblem('Pick when the rosters lock.'); return; }
      rosterLock = { kind: 'at', at };
    }
    setProblem(null);
    onSave({ ...f, startsAt, roster: { ...f.roster, lock: rosterLock } });
  };

  return (
    <form class="admin-form admin-form--stack" onSubmit={submit}>
      {problem && <p class="error" role="alert">{problem}</p>}
      <label class="teamfield">Name<input aria-label="Name" value={f.name} maxLength={60} onInput={(e) => set({ name: val(e) })} /></label>
      <label class="teamfield">Starts at (your time)<input aria-label="Starts at" type="datetime-local" value={start} onInput={(e) => setStart(val(e))} /></label>
      <label class="teamfield">Entries
        <select aria-label="Entry kind" value={f.entryKind} disabled={status !== 'draft'} onChange={(e) => set({ entryKind: (e.target as HTMLSelectElement).value as EntryKind })}>
          <option value="team">Teams register</option>
          <option value="draft">Draft (individual signups)</option>
        </select>
      </label>
      <label><input type="checkbox" aria-label="Official event" checked={f.official} onChange={() => set({ official: !f.official })} /> Official event</label>
      <label class="teamfield">Team cap (blank for none)
        <input aria-label="Team cap" type="number" min={2} max={256} value={f.teamCap ?? ''} onInput={(e) => set({ teamCap: numOrNull(val(e)) })} />
      </label>
      <div class="teamfield">
        <span class="inlinerow">
          Description (# heading, **bold**, *italic*, - list, [text](https://...))
          <button type="button" class="btn btn--ghost btn--sm" aria-pressed={preview} onClick={() => setPreview(!preview)}>{preview ? 'Edit' : 'Preview'}</button>
        </span>
        {preview
          ? <div class="eventdesc-preview"><RichText text={f.description} /></div>
          : <textarea aria-label="Description" maxLength={4000} value={f.description} onInput={(e) => set({ description: (e.target as HTMLTextAreaElement).value })} />}
      </div>
      <fieldset class="bookform__fieldset">
        <legend class="teamsub">Eligibility</legend>
        <label class="teamfield">Minimum completed PUGs
          <input aria-label="Minimum completed PUGs" type="number" min={0} max={1000} value={f.eligibility.minPugs} onInput={(e) => elig({ minPugs: Number(val(e)) })} />
        </label>
        <label><input type="checkbox" aria-label="Discord linked" checked={f.eligibility.requireDiscord} onChange={() => elig({ requireDiscord: !f.eligibility.requireDiscord })} /> Discord linked</label>
        <label class="teamfield">SR floor (blank for none)
          <input aria-label="SR floor" type="number" min={0} value={f.eligibility.srFloor ?? ''} onInput={(e) => elig({ srFloor: numOrNull(val(e)) })} />
        </label>
        <label class="teamfield">SR ceiling (blank for none)
          <input aria-label="SR ceiling" type="number" min={0} value={f.eligibility.srCeiling ?? ''} onInput={(e) => elig({ srCeiling: numOrNull(val(e)) })} />
        </label>
      </fieldset>
      <fieldset class="bookform__fieldset">
        <legend class="teamsub">Check-in</legend>
        <label><input type="checkbox" aria-label="Check-in on" checked={f.checkin.enabled} onChange={() => checkin({ enabled: !f.checkin.enabled })} /> Check-in on</label>
        {f.checkin.enabled && (
          <>
            <label class="teamfield">Opens (minutes before the start)
              <input aria-label="Check-in opens" type="number" min={10} max={1440} value={f.checkin.opensMinutes} onInput={(e) => checkin({ opensMinutes: Number(val(e)) })} />
            </label>
            <label class="teamfield">Closes (minutes before the start)
              <input aria-label="Check-in closes" type="number" min={0} max={1435} value={f.checkin.closesMinutes} onInput={(e) => checkin({ closesMinutes: Number(val(e)) })} />
            </label>
          </>
        )}
      </fieldset>
      <fieldset class="bookform__fieldset">
        <legend class="teamsub">Rosters (4 starters)</legend>
        <label class="teamfield">Max subs
          <input aria-label="Max subs" type="number" min={0} max={4} value={f.roster.maxSubs} onInput={(e) => roster({ maxSubs: Number(val(e)) })} />
        </label>
        <label class="teamfield">Roster lock
          <select aria-label="Roster lock" value={lock.kind} onChange={(e) => setLockKind((e.target as HTMLSelectElement).value as RosterLock['kind'])}>
            <option value="none">No lock</option>
            <option value="at">At a time</option>
            <option value="after_round">After a round</option>
          </select>
        </label>
        {lock.kind === 'at' && (
          <label class="teamfield">Lock at (your time)<input aria-label="Lock at" type="datetime-local" value={lockAt} onInput={(e) => setLockAt(val(e))} /></label>
        )}
        {lock.kind === 'after_round' && (
          <>
            <label class="teamfield">After stage
              <input aria-label="Lock after stage" type="number" min={1} max={5} value={lock.stage} onInput={(e) => roster({ lock: { ...lock, stage: Number(val(e)) } })} />
            </label>
            <label class="teamfield">Round
              <input aria-label="Lock after round" type="number" min={1} max={20} value={lock.round} onInput={(e) => roster({ lock: { ...lock, round: Number(val(e)) } })} />
            </label>
          </>
        )}
        <label class="teamfield">Max roster additions before the lock (blank for no limit)
          <input aria-label="Max roster additions" type="number" min={0} max={20} value={f.roster.maxAdditions ?? ''} onInput={(e) => roster({ maxAdditions: numOrNull(val(e)) })} />
        </label>
      </fieldset>
      <button class="btn" type="submit" disabled={busy}>Save event</button>
    </form>
  );
}
```

- [ ] **Step 6: Write `web/src/routes/admin/events/EventEditor.tsx`**

```tsx
import { useState } from 'preact/hooks';
import { adminApi, ApiError, bannerUrl, type AdminEventDetail } from '../../../api';
import { useFetch } from '../../../hooks/useFetch';
import { Empty, Panel } from '../../../components/bits';
import { RichText } from '../../../components/RichText';
import { STATUS_LABEL, whenText } from '../../../eventFormat';
import { toBannerImage } from '../../../eventBanner';
import { fmtTime, useAction } from '../useAction';
import { EventFieldsForm } from './EventFieldsForm';
import { StageForm } from './StageForm';

/** Mirrors V.EVENT_EDITABLE and V.STAGES_LOCKED (src/events/validate.ts). */
const EDITABLE: readonly string[] = ['draft', 'announced', 'registration'];
const STAGES_LOCKED: readonly string[] = ['live', 'finished', 'cancelled'];
const ACTION_TEXT: Record<string, string> = {
  created: 'Created', edited: 'Edited', stage_added: 'Stage added', stage_edited: 'Stage edited', stage_removed: 'Stage removed',
  stages_reordered: 'Stages reordered', published: 'Published', registration_opened: 'Registration opened', cancelled: 'Cancelled',
  banner_set: 'Banner set', banner_removed: 'Banner removed',
};

/** What a mod reads in place of the form (Ruling 2). */
function Details({ ev }: { ev: AdminEventDetail }) {
  const f = ev.fields;
  return (
    <ul class="admin-list">
      <li>Starts {whenText(f.startsAt)}</li>
      <li>{f.entryKind === 'team' ? 'Teams register' : 'Draft (individual signups)'}{f.official ? ', official' : ''}{f.teamCap !== null ? `, up to ${f.teamCap} teams` : ''}</li>
      <li>At least {f.eligibility.minPugs} completed PUGs{f.eligibility.requireDiscord ? ', Discord linked' : ''}</li>
      <li>{f.checkin.enabled ? `Check-in ${f.checkin.opensMinutes} to ${f.checkin.closesMinutes} minutes before the start` : 'No check-in'}</li>
      {f.description && <li><RichText text={f.description} /></li>}
    </ul>
  );
}

/** One event on the Events desk: lifecycle, fields, banner, stages, history.
 *  canEdit false (a mod) shows the same event with no control at all; the
 *  server refuses every write from a mod regardless. */
export function EventEditor({ id, canEdit }: { id: number; canEdit: boolean }) {
  const { data: ev, error: loadError, reload } = useFetch((s) => adminApi.event(id, s), [id]);
  const { data: options } = useFetch((s) => adminApi.eventOptions(s), []);
  const { busy, error, run } = useAction(reload);
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [reason, setReason] = useState('');

  if (loadError instanceof ApiError && loadError.status === 404) return <Panel><Empty>No such event.</Empty></Panel>;
  if (!ev || !options) return <Panel><p class="muted">Loading...</p></Panel>;

  const stagesOpen = canEdit && !STAGES_LOCKED.includes(ev.status);
  const over = ev.status === 'finished' || ev.status === 'cancelled';
  const move = (i: number, by: -1 | 1) => {
    const ids = ev.stages.map((s) => s.id);
    [ids[i], ids[i + by]] = [ids[i + by], ids[i]];
    void run(() => adminApi.reorderStages(id, ids));
  };
  /** Closes the stage form only once the server took the stage. */
  const saveStage = (call: () => Promise<unknown>) => {
    void run(async () => { await call(); setEditing(null); });
  };

  return (
    <div class="stack">
      <Panel>
        <h3>{ev.fields.name} <span class={`teamchip eventstatus eventstatus--${ev.status}`}>{STATUS_LABEL[ev.status]}</span></h3>
        <p class="muted"><a href={`/event/${ev.slug}`}>/event/{ev.slug}</a> · last change {fmtTime(ev.updatedAt)}</p>
        {ev.cancelReason && <p class="muted">Cancelled: {ev.cancelReason}</p>}
        {!canEdit && <p class="muted">Read only: admins run events.</p>}
        {error && <p class="error" role="alert">{error}</p>}
        {canEdit && (
          <div class="inlinerow">
            {ev.status === 'draft' && (
              <button class="btn" disabled={busy}
                onClick={() => void run(() => adminApi.publishEvent(id), 'Publish this event? Everyone the competitive switch lets in will see it on /events.')}>
                Publish
              </button>
            )}
            {ev.status === 'announced' && ev.fields.entryKind === 'team' && (
              <button class="btn" disabled={busy} onClick={() => void run(() => adminApi.openEventRegistration(id), 'Open registration?')}>
                Open registration
              </button>
            )}
          </div>
        )}
        {canEdit && !over && (
          <form class="admin-form" onSubmit={(e) => { e.preventDefault(); void run(() => adminApi.cancelEvent(id, reason), 'Cancel this event? It cannot be reopened.'); }}>
            <input aria-label="Cancel reason" placeholder="Reason, shown on the event page" maxLength={300} value={reason}
              onInput={(e) => setReason((e.target as HTMLInputElement).value)} />
            <button class="btn btn--danger" type="submit" disabled={busy}>Cancel event</button>
          </form>
        )}
      </Panel>
      <Panel>
        <h3>Event</h3>
        {canEdit && EDITABLE.includes(ev.status)
          ? <EventFieldsForm key={ev.updatedAt} fields={ev.fields} status={ev.status} busy={busy} onSave={(f) => void run(() => adminApi.updateEvent(id, f))} />
          : <Details ev={ev} />}
      </Panel>
      <Panel>
        <h3>Banner</h3>
        {ev.bannerKey ? <img class="eventbanner" src={bannerUrl(ev.bannerKey)} alt="" width={1600} height={400} /> : <Empty>No banner.</Empty>}
        {canEdit && (
          <div class="inlinerow">
            <label class="btn btn--ghost btn--sm">
              {ev.bannerKey ? 'Replace banner' : 'Upload banner'}
              <input class="sr-only" type="file" accept="image/png,image/jpeg,image/webp" aria-label="Banner" disabled={busy} onChange={(e) => {
                const f = (e.target as HTMLInputElement).files?.[0];
                if (f) void run(async () => adminApi.setEventBanner(id, await toBannerImage(f)));
              }} />
            </label>
            {ev.bannerKey && (
              <button class="btn btn--ghost btn--sm" disabled={busy} onClick={() => void run(() => adminApi.removeEventBanner(id), 'Remove the banner?')}>
                Remove banner
              </button>
            )}
            <span class="muted">Cropped to 4:1 and scaled to 1600 x 400.</span>
          </div>
        )}
      </Panel>
      <Panel>
        <h3>Stages</h3>
        {ev.stages.length === 0 ? <Empty>No stages yet. An event needs at least one before it can be published.</Empty> : (
          <ol class="admin-list">
            {ev.stages.map((s, i) => (
              <li key={s.id}>
                <strong>Stage {s.ordinal}</strong> <span>{s.summary}</span>
                {stagesOpen && (
                  <span class="inlinerow">
                    <button class="btn btn--ghost btn--sm" aria-label={`Move stage ${s.ordinal} up`} disabled={busy || i === 0} onClick={() => move(i, -1)}>Up</button>
                    <button class="btn btn--ghost btn--sm" aria-label={`Move stage ${s.ordinal} down`} disabled={busy || i === ev.stages.length - 1} onClick={() => move(i, 1)}>Down</button>
                    <button class="btn btn--ghost btn--sm" aria-label={`Edit stage ${s.ordinal}`} disabled={editing !== null} onClick={() => setEditing(s.id)}>Edit</button>
                    <button class="btn btn--ghost btn--sm" aria-label={`Remove stage ${s.ordinal}`} disabled={busy}
                      onClick={() => void run(() => adminApi.removeStage(id, s.id), `Remove stage ${s.ordinal}?`)}>Remove</button>
                  </span>
                )}
                {editing === s.id && (
                  <StageForm options={options} initial={s.settings} busy={busy} onCancel={() => setEditing(null)}
                    onSave={(st) => saveStage(() => adminApi.updateStage(id, s.id, st))} />
                )}
              </li>
            ))}
          </ol>
        )}
        {stagesOpen && editing === null && <button class="btn" onClick={() => setEditing('new')}>Add stage</button>}
        {editing === 'new' && (
          <StageForm options={options} initial={null} busy={busy} onCancel={() => setEditing(null)}
            onSave={(st) => saveStage(() => adminApi.addStage(id, st))} />
        )}
      </Panel>
      <Panel>
        <h3>History</h3>
        <ul class="admin-list">
          {ev.log.map((l, i) => <li key={i}>{fmtTime(l.at)} · {l.actorName ?? 'the site'} · {ACTION_TEXT[l.action] ?? l.action}</li>)}
        </ul>
      </Panel>
    </div>
  );
}
```

Then write `web/src/eventBanner.ts` (the editor's tests mock it: happy-dom has no canvas, as with `web/src/teamLogo.ts`):

```ts
/** The server takes exactly 1600 x 400 PNG or WebP banners
 *  (src/community/validate.ts checkBanner), so whatever the admin picks
 *  (PNG, JPEG or WebP) is centre-cropped to 4:1 and scaled here first, then
 *  written as WebP, or as PNG on a browser that cannot write WebP (its
 *  toDataURL then hands back a PNG). Returns base64 without the data: prefix. */
export async function toBannerImage(file: File): Promise<string> {
  const bmp = await createImageBitmap(file);
  const w = Math.min(bmp.width, bmp.height * 4);
  const h = w / 4;
  const canvas = document.createElement('canvas');
  canvas.width = 1600;
  canvas.height = 400;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot resize images.');
  ctx.drawImage(bmp, (bmp.width - w) / 2, (bmp.height - h) / 2, w, h, 0, 0, 1600, 400);
  bmp.close();
  const url = canvas.toDataURL('image/webp', 0.9);
  return url.replace(/^data:image\/(webp|png);base64,/, '');
}
```

- [ ] **Step 7: Mount the editor in the panel**

In `web/src/routes/Admin.tsx`, after `import { EventsDesk } from './admin/events/EventsDesk';`:

```tsx
import { EventEditor } from './admin/events/EventEditor';
```

Right after `{r.desk === 'events' && r.section === 'list' && <EventsDesk canEdit={isAdmin} />}`:

```tsx
        {r.desk === 'events' && r.section === 'event' && <EventEditor key={r.param} id={Number(r.param)} canEdit={isAdmin} />}
```

- [ ] **Step 8: Run the tests and typecheck**

Run: `npx vitest run web/src/routes/admin/events && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 9: Commit**

```bash
git add web/src/routes/admin/events web/src/routes/Admin.tsx web/src/eventBanner.ts
git commit -m "Events: the event editor with fields and Preview, banner, stages, lifecycle and history, read only for mods"
```

---

### Task 10: The public `/events` and `/event/:slug` pages

**Files:**
- Create: `web/src/routes/Events.tsx`
- Create: `web/src/routes/Event.tsx`
- Modify: `web/src/AppRoutes.tsx` (lazy imports after `const Scrims = lazy(() => import('./routes/Scrims'));`; routes after `<Route path="/scrims" component={Scrims} session={session} />`)
- Modify: `web/src/styles/app.css` (append at the end)
- Test: `web/src/routes/Events.test.tsx`, `web/src/routes/Event.test.tsx`, `web/src/appRoutes.test.tsx` (one case)

**Interfaces:**
- Consumes: Task 7 `eventsApi`, `bannerUrl`, `EventListItem`, `EventView`, `STATUS_LABEL`, `untilText`, `whenText`; Task 8 `RichText`; `PageHeader` (`web/src/components/PageHeader.tsx`); `Panel`, `Empty`; `Session` (`web/src/hooks/useLiveState.ts`).
- Produces: `Events({ session }: { session: Session })` (default export), `EventPage({ slug, session }: { slug: string; session: Session })` (default export of `Event.tsx`); routes `/events` and `/event/:slug`; the banner above the event page header and as a 160 x 40 thumbnail on a list row; the description through `RichText`.

- [ ] **Step 1: Write the failing tests**

`web/src/routes/Events.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/preact';
import type { EventListItem } from '../api';

const { mockEvents } = vi.hoisted(() => ({ mockEvents: { list: vi.fn(), get: vi.fn() } }));
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, eventsApi: mockEvents };
});
const { Events } = await import('./Events');
const { ApiError } = await import('../api');

const item = (over: Partial<EventListItem>): EventListItem => ({
  slug: 'cup', name: 'Cup', status: 'announced', entryKind: 'team', official: true, startsAt: '2026-10-10T20:00:00.000Z', bannerKey: null,
  format: ['Swiss', 'Single elimination'], entries: 0, ...over,
});
const session = { kind: 'anonymous' } as const;

afterEach(cleanup);
beforeEach(() => { mockEvents.list.mockReset(); });

describe('Events', () => {
  it('splits upcoming from past, each row a link with its status and format', async () => {
    mockEvents.list.mockResolvedValue({ events: [
      item({ slug: 'spring-cup', name: 'Spring Cup', status: 'registration', entries: 3 }),
      item({ slug: 'old-cup', name: 'Old Cup', status: 'cancelled' }),
    ] });
    render(<Events session={session} />);
    const row = (await screen.findByText('Spring Cup')).closest('a') as HTMLAnchorElement;
    expect(row.getAttribute('href')).toBe('/event/spring-cup');
    expect(screen.getByText('Registration open')).toBeTruthy();
    expect(screen.getAllByText(/Swiss, then Single elimination/)).toHaveLength(2);
    expect(screen.getByText(/3 teams/)).toBeTruthy();
    expect(screen.getByText('Past')).toBeTruthy();
    expect(screen.getByText('Cancelled')).toBeTruthy();
  });

  it('shows a banner thumbnail on a row that has one', async () => {
    mockEvents.list.mockResolvedValue({ events: [item({ name: 'Spring Cup', bannerKey: 'd'.repeat(64) }), item({ slug: 'plain', name: 'Plain Cup' })] });
    const { container } = render(<Events session={session} />);
    await screen.findByText('Spring Cup');
    const thumbs = container.querySelectorAll('img.eventrow__banner');
    expect(thumbs).toHaveLength(1);
    expect(thumbs[0]!.getAttribute('src')).toBe(`/api/events/banners/${'d'.repeat(64)}`);
  });

  it('says nothing is scheduled when there is nothing', async () => {
    mockEvents.list.mockResolvedValue({ events: [] });
    render(<Events session={session} />);
    expect(await screen.findByText('Nothing is scheduled yet.')).toBeTruthy();
    expect(screen.queryByText('Past')).toBeNull();
  });

  it('says events are not open when the switch keeps the viewer out', async () => {
    mockEvents.list.mockRejectedValue(new ApiError(404, 'not found'));
    render(<Events session={session} />);
    expect(await screen.findByText('Events are not open yet.')).toBeTruthy();
  });
});
```

`web/src/routes/Event.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/preact';
import type { EventView } from '../api';

const { mockEvents } = vi.hoisted(() => ({ mockEvents: { list: vi.fn(), get: vi.fn() } }));
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, eventsApi: mockEvents };
});
const { EventPage } = await import('./Event');
const { ApiError } = await import('../api');

const inMinutes = (m: number) => new Date(Date.now() + m * 60_000 + 30_000).toISOString();
const view = (over: Partial<EventView> = {}): EventView => ({
  slug: 'riverside-cup', name: 'Riverside Cup', status: 'announced', entryKind: 'team', official: true, organizerName: 'boss',
  bannerKey: null, startsAt: inMinutes((2 * 24 + 3) * 60), description: '', teamCap: 16,
  eligibility: { minPugs: 5, requireDiscord: true, srFloor: null, srCeiling: 2500 },
  checkin: { enabled: true, opensMinutes: 60, closesMinutes: 15 },
  roster: { starters: 4, maxSubs: 2, lock: { kind: 'none' }, maxAdditions: null },
  stages: [
    {
      ordinal: 1, type: 'swiss', summary: 'Swiss, 4 rounds, top 8 advance', veto: 'Ban to one (Bo1)', chapters: 'Every chapter but the finale',
      scheduling: 'rolling', rulesetName: 'Standard Cup', rules: ['No-show grace: 15 minutes', 'Higher seed picks sides'], gameConfig: 'Standard',
      campaigns: [{ slug: 'no_mercy', name: 'No Mercy' }, { slug: 'dead_air', name: 'Dead Air' }],
    },
    {
      ordinal: 2, type: 'single_elim', summary: 'Single elimination, third-place match', veto: 'Ban to one (Bo1)', chapters: '3 chapters',
      scheduling: 'rolling', rulesetName: 'Standard Cup', rules: [], gameConfig: 'Standard', campaigns: [{ slug: 'dead_air', name: 'Dead Air' }],
    },
  ],
  entries: [], finishedAt: null, cancelledAt: null, cancelReason: null,
  ...over,
});
const session = { kind: 'anonymous' } as const;

afterEach(cleanup);
beforeEach(() => { mockEvents.get.mockReset(); });

describe('EventPage', () => {
  it('shows the status, the countdown, the format strip, rules and pools, entry rules and no teams yet', async () => {
    mockEvents.get.mockResolvedValue(view());
    render(<EventPage slug="riverside-cup" session={session} />);
    expect(await screen.findByText('Riverside Cup')).toBeTruthy();
    expect(screen.getByText('Official event')).toBeTruthy();
    expect(screen.getByText('Announced')).toBeTruthy();
    expect(screen.getByText(/in 2 days 3 h/)).toBeTruthy();
    expect(screen.getAllByText('Swiss, 4 rounds, top 8 advance').length).toBeGreaterThan(0);
    expect(screen.getByText('Single elimination, third-place match')).toBeTruthy();
    expect(screen.getByText('Higher seed picks sides')).toBeTruthy();
    expect(screen.getAllByText('Dead Air')).toHaveLength(2);
    expect(screen.getByText('At least 5 completed PUGs, account in good standing')).toBeTruthy();
    expect(screen.getByText('SR 2500 or less')).toBeTruthy();
    expect(screen.getByText('4 starters and up to 2 subs')).toBeTruthy();
    expect(screen.getByText('Up to 16 teams')).toBeTruthy();
    expect(screen.getByText('Check-in opens 60 minutes before the start and closes 15 minutes before')).toBeTruthy();
    expect(screen.getByText('No teams have entered yet.')).toBeTruthy();
  });

  it('formats the description with the safe subset, and shows HTML in it as text', async () => {
    mockEvents.get.mockResolvedValue(view({ description: '## Rules\n**Be on time.** <b>two</b>\n[Discord](javascript:alert(1))' }));
    const { container } = render(<EventPage slug="riverside-cup" session={session} />);
    await screen.findByText('Riverside Cup');
    const desc = container.querySelector('.eventdesc') as HTMLElement;
    expect(desc.querySelector('h4')?.textContent).toBe('Rules');
    expect(desc.querySelector('strong')?.textContent).toBe('Be on time.');
    expect(desc.querySelector('b')).toBeNull();
    expect(desc.querySelector('a')).toBeNull();
    expect(desc.textContent).toContain('<b>two</b>');
    expect(desc.textContent).toContain('[Discord](javascript:alert(1))');
  });

  it('shows the banner above the header when the event has one', async () => {
    mockEvents.get.mockResolvedValue(view({ bannerKey: 'c'.repeat(64) }));
    const { container } = render(<EventPage slug="riverside-cup" session={session} />);
    await screen.findByText('Riverside Cup');
    expect((container.querySelector('img.eventbanner') as HTMLImageElement).getAttribute('src')).toBe(`/api/events/banners/${'c'.repeat(64)}`);
  });

  it('a draft-kind event says its signups open later', async () => {
    mockEvents.get.mockResolvedValue(view({ entryKind: 'draft' }));
    render(<EventPage slug="riverside-cup" session={session} />);
    expect(await screen.findByText('Draft event: individual signups open later.')).toBeTruthy();
    expect(screen.getByText('No entries yet.')).toBeTruthy();
    expect(screen.queryByText('Up to 16 teams')).toBeNull();
  });

  it('a cancelled event says so, with the reason, and no countdown', async () => {
    mockEvents.get.mockResolvedValue(view({ status: 'cancelled', cancelReason: 'Not enough teams' }));
    render(<EventPage slug="riverside-cup" session={session} />);
    expect(await screen.findByText('This event was cancelled: Not enough teams')).toBeTruthy();
    expect(screen.queryByText(/in 2 days/)).toBeNull();
  });

  it('a draft staff preview is marked as such', async () => {
    mockEvents.get.mockResolvedValue(view({ status: 'draft' }));
    render(<EventPage slug="riverside-cup" session={session} />);
    expect(await screen.findByText('Draft: only staff can see this page.')).toBeTruthy();
  });

  it('an unknown event, or a closed switch, is the missing state', async () => {
    mockEvents.get.mockRejectedValue(new ApiError(404, 'not found'));
    render(<EventPage slug="nope" session={session} />);
    expect(await screen.findByText('No such event, or events are not open yet.')).toBeTruthy();
  });
});
```

Add to `web/src/appRoutes.test.tsx`, inside `describe('the site route table', ...)`:

```tsx
  it('mounts the events list and an event page, not the 404', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    const first = open('/events');
    expect(await screen.findByText('Events are not open yet.')).toBeTruthy();
    first.unmount();
    open('/event/riverside-cup');
    expect(await screen.findByText('No such event, or events are not open yet.')).toBeTruthy();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run web/src/routes/Events.test.tsx web/src/routes/Event.test.tsx web/src/appRoutes.test.tsx`
Expected: FAIL with missing modules `./Events` and `./Event`, and the route test finding `Page not found`.

- [ ] **Step 3: Write `web/src/routes/Events.tsx`**

```tsx
import { useEffect, useState } from 'preact/hooks';
import { ApiError, bannerUrl, eventsApi, type EventListItem } from '../api';
import { Empty, Panel } from '../components/bits';
import { PageHeader } from '../components/PageHeader';
import type { Session } from '../hooks/useLiveState';
import { STATUS_LABEL, whenText } from '../eventFormat';

const OVER = new Set(['finished', 'cancelled']);

function EventRow({ ev }: { ev: EventListItem }) {
  const count = ev.entryKind === 'team' ? `${ev.entries} team${ev.entries === 1 ? '' : 's'}` : `${ev.entries} entr${ev.entries === 1 ? 'y' : 'ies'}`;
  return (
    <li>
      <a class="eventrow" href={`/event/${ev.slug}`}>
        {ev.bannerKey && <img class="eventrow__banner" src={bannerUrl(ev.bannerKey)} alt="" width={160} height={40} loading="lazy" />}
        <span class="eventrow__name">{ev.name}</span>
        <span class={`teamchip eventstatus eventstatus--${ev.status}`}>{STATUS_LABEL[ev.status]}</span>
        <span class="eventrow__meta">
          {whenText(ev.startsAt)}
          {ev.format.length > 0 && <> · {ev.format.join(', then ')}</>}
          {ev.entries > 0 && <> · {count}</>}
        </span>
      </a>
    </li>
  );
}

/** Every event, upcoming first then past (spec section 7). */
export function Events({ session }: { session: Session }) {
  const [events, setEvents] = useState<EventListItem[] | null>(null);
  const [closed, setClosed] = useState(false);

  useEffect(() => {
    const ctl = new AbortController();
    eventsApi.list(ctl.signal).then((r) => setEvents(r.events), (e) => { if (e instanceof ApiError && e.status === 404) setClosed(true); });
    return () => ctl.abort();
  }, [session.kind]);

  const head = <PageHeader eyebrow="Competitive" title="Events" />;
  if (closed) return <main class="page page--list">{head}<Empty>Events are not open yet.</Empty></main>;
  if (!events) return <main class="page page--list">{head}</main>;
  const upcoming = events.filter((e) => !OVER.has(e.status));
  const past = events.filter((e) => OVER.has(e.status));

  return (
    <main class="page page--list">
      {head}
      <Panel>
        <h3>Upcoming and running</h3>
        {upcoming.length === 0 ? <Empty>Nothing is scheduled yet.</Empty>
          : <ul class="eventlist">{upcoming.map((ev) => <EventRow key={ev.slug} ev={ev} />)}</ul>}
      </Panel>
      {past.length > 0 && (
        <Panel>
          <h3>Past</h3>
          <ul class="eventlist">{past.map((ev) => <EventRow key={ev.slug} ev={ev} />)}</ul>
        </Panel>
      )}
    </main>
  );
}

export default Events;
```

- [ ] **Step 4: Write `web/src/routes/Event.tsx`**

```tsx
import { useEffect, useState } from 'preact/hooks';
import { ApiError, bannerUrl, eventsApi, type EventView } from '../api';
import { RichText } from '../components/RichText';
import { Empty, Panel } from '../components/bits';
import { PageHeader } from '../components/PageHeader';
import type { Session } from '../hooks/useLiveState';
import { STATUS_LABEL, untilText, whenText } from '../eventFormat';

const BEFORE_START = new Set(['draft', 'announced', 'registration', 'checkin']);

/** The clock for the countdown. Minutes are the finest unit it shows, so a
 *  30 s tick is enough. */
function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** Who may enter, as sentences. */
function entryLines(ev: EventView): string[] {
  const e = ev.eligibility;
  const lines = [`At least ${e.minPugs} completed PUG${e.minPugs === 1 ? '' : 's'}, account in good standing`];
  if (e.requireDiscord) lines.push('Discord linked to the site');
  if (e.srFloor !== null && e.srCeiling !== null) lines.push(`SR ${e.srFloor} to ${e.srCeiling}`);
  else if (e.srFloor !== null) lines.push(`SR ${e.srFloor} or more`);
  else if (e.srCeiling !== null) lines.push(`SR ${e.srCeiling} or less`);
  if (ev.entryKind === 'team') {
    lines.push(`4 starters and up to ${ev.roster.maxSubs} sub${ev.roster.maxSubs === 1 ? '' : 's'}`);
    if (ev.teamCap !== null) lines.push(`Up to ${ev.teamCap} teams`);
  }
  lines.push(ev.checkin.enabled
    ? `Check-in opens ${ev.checkin.opensMinutes} minutes before the start and closes ${ev.checkin.closesMinutes} minutes before`
    : 'No check-in');
  return lines;
}

/** One event, read only (spec section 7, T1a part): status and countdown,
 *  format strip, rules and pools per stage, who may enter, entries. */
export function EventPage({ slug, session }: { slug: string; session: Session }) {
  const [ev, setEv] = useState<EventView | null>(null);
  const [missing, setMissing] = useState(false);
  const now = useNow();

  useEffect(() => {
    const ctl = new AbortController();
    setEv(null);
    setMissing(false);
    eventsApi.get(slug, ctl.signal).then(setEv, (e) => { if (e instanceof ApiError && e.status === 404) setMissing(true); });
    return () => ctl.abort();
  }, [slug, session.kind]);

  if (missing) return <main class="page page--profile"><PageHeader title="Event" /><Empty>No such event, or events are not open yet.</Empty></main>;
  if (!ev) return <main class="page page--profile"><PageHeader title="Event" /></main>;

  return (
    <main class="page page--profile eventpage">
      {ev.bannerKey && <img class="eventbanner" src={bannerUrl(ev.bannerKey)} alt="" width={1600} height={400} />}
      <PageHeader
        eyebrow={ev.official ? 'Official event' : 'Community event'}
        title={ev.name}
        aside={<span class={`teamchip eventstatus eventstatus--${ev.status}`}>{STATUS_LABEL[ev.status]}</span>}
      >
        <p class="eventpage__when">
          Starts {whenText(ev.startsAt)}
          {BEFORE_START.has(ev.status) && <span class="eventpage__countdown"> · {untilText(ev.startsAt, now)}</span>}
          {ev.organizerName && <span class="muted"> · organized by {ev.organizerName}</span>}
        </p>
      </PageHeader>
      {ev.status === 'draft' && <p class="warning">Draft: only staff can see this page.</p>}
      {ev.status === 'cancelled' && <p class="warning">This event was cancelled{ev.cancelReason ? `: ${ev.cancelReason}` : '.'}</p>}
      {ev.description && <Panel><RichText class="eventdesc" text={ev.description} /></Panel>}
      <Panel>
        <h3>Format</h3>
        {ev.stages.length === 0 ? <Empty>The format is not set yet.</Empty> : (
          <ol class="eventstrip">
            {ev.stages.map((s) => (
              <li key={s.ordinal} class="eventstrip__stage">
                <span class="eyebrow">Stage {s.ordinal}</span>
                <strong>{s.summary}</strong>
              </li>
            ))}
          </ol>
        )}
      </Panel>
      {ev.stages.map((s) => (
        <Panel key={s.ordinal}>
          <h3>Stage {s.ordinal}: rules and campaigns</h3>
          <p class="muted">
            {s.rulesetName ?? 'Ruleset'} · {s.veto} · {s.chapters} · {s.scheduling === 'window' ? 'played in scheduled windows' : 'played in one session'} · {s.gameConfig}
          </p>
          {s.rules.length > 0 && <ul class="eventrules">{s.rules.map((r) => <li key={r}>{r}</li>)}</ul>}
          <p class="eventpool">{s.campaigns.map((c) => <span key={c.slug} class="chip">{c.name}</span>)}</p>
        </Panel>
      ))}
      <Panel>
        <h3>Entry</h3>
        {ev.entryKind === 'draft' && <p>Draft event: individual signups open later.</p>}
        <ul class="eventrules">{entryLines(ev).map((l) => <li key={l}>{l}</li>)}</ul>
      </Panel>
      <Panel>
        <h3>{ev.entryKind === 'team' ? 'Teams' : 'Entries'}</h3>
        {ev.entries.length === 0
          ? <Empty>{ev.entryKind === 'team' ? 'No teams have entered yet.' : 'No entries yet.'}</Empty>
          : (
            <ul class="eventlist">
              {ev.entries.map((e) => (
                <li key={`${e.seed ?? ''}-${e.name}`}>
                  {e.seed !== null && <span class="muted">#{e.seed} </span>}{e.name}{e.tag && <span class="muted"> [{e.tag}]</span>}
                </li>
              ))}
            </ul>
          )}
      </Panel>
    </main>
  );
}

export default EventPage;
```

- [ ] **Step 5: Add the routes**

In `web/src/AppRoutes.tsx`, after `const Scrims = lazy(() => import('./routes/Scrims'));`:

```tsx
// Events: behind the same competitive switch.
const Events = lazy(() => import('./routes/Events'));
const EventPage = lazy(() => import('./routes/Event'));
```

After `<Route path="/scrims" component={Scrims} session={session} />`:

```tsx
      <Route path="/events" component={Events} session={session} />
      <Route path="/event/:slug" component={EventPage} session={session} />
```

The server's SPA fallback already serves `index.html` for both paths.

- [ ] **Step 6: Add the styles**

Append to `web/src/styles/app.css`:

```css
/* Events (tournaments plan T1a): the list, the status chip, the event page,
   the banner (also on the desk) and the description preview. */
.eventlist { list-style: none; margin: 0; padding: 0; }
.eventrow { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2) var(--sp-3); padding: var(--sp-3) 0; border-bottom: 1px solid var(--border); color: inherit; text-decoration: none; }
.eventlist li:last-child .eventrow { border-bottom: 0; }
.eventrow__name { font-weight: 600; overflow-wrap: anywhere; }
.eventrow__meta { flex-basis: 100%; color: var(--text-muted); font-size: var(--fs-dense); }
.eventstatus--registration, .eventstatus--checkin, .eventstatus--live { border-color: var(--rule); color: var(--accent); }
.eventstatus--cancelled { color: var(--loss); }
.eventstatus--draft { border-style: dashed; }
.eventpage__when { margin: var(--sp-2) 0 0; }
.eventdesc { overflow-wrap: anywhere; }
.eventbanner { display: block; width: 100%; height: auto; aspect-ratio: 4 / 1; object-fit: cover; border: 1px solid var(--border); }
.eventrow__banner { width: 160px; height: 40px; object-fit: cover; border: 1px solid var(--border); }
.eventdesc-preview { padding: var(--sp-3); border: 1px dashed var(--border); }
/* The safe markdown subset (web/src/components/RichText.tsx). */
.richtext > :first-child { margin-top: 0; }
.richtext > :last-child { margin-bottom: 0; }
.richtext p, .richtext ul, .richtext ol { margin: 0 0 var(--sp-3); }
.richtext ul, .richtext ol { padding-left: var(--sp-5); }
.richtext a { overflow-wrap: anywhere; }
.eventstrip { display: flex; flex-wrap: wrap; gap: var(--sp-3); list-style: none; margin: 0; padding: 0; }
.eventstrip__stage { display: flex; flex-direction: column; gap: var(--sp-1); flex: 1 1 200px; min-width: 0; padding: var(--sp-3); border: 1px solid var(--border); }
.eventrules { margin: var(--sp-2) 0; padding-left: var(--sp-5); }
.eventpool { display: flex; flex-wrap: wrap; gap: var(--sp-2); margin: var(--sp-2) 0 0; }
```

- [ ] **Step 7: Run the tests and typecheck**

Run: `npx vitest run web/src/routes/Events.test.tsx web/src/routes/Event.test.tsx web/src/appRoutes.test.tsx && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 8: Commit**

```bash
git add web/src/routes/Events.tsx web/src/routes/Event.tsx web/src/routes/Events.test.tsx web/src/routes/Event.test.tsx web/src/AppRoutes.tsx web/src/appRoutes.test.tsx web/src/styles/app.css
git commit -m "Events: public events list with banner thumbnails and the read-only event page with banner and formatted description"
```

---

### Task 11: Nav link, the gating sweep, and the whole suite

**Files:**
- Modify: `web/src/components/Nav.tsx`
- Modify: `web/src/components/Nav.test.tsx` (one case)
- Test: `tests/eventGating.test.ts` (new)

**Interfaces:**
- Consumes: everything above. `/api/me` already returns `teams: competitiveAccess(...)`, which the nav reads for every competitive link.
- Produces: an `Events` nav item (`/events`) after Scrims, current on `/events` and every `/event/...` page, shown only when `me.teams` is true.

- [ ] **Step 1: Write the failing tests**

In `web/src/components/Nav.test.tsx`, replace the case `'offers Teams, Bookings and Scrims only to a viewer the competitive switch lets in'` with:

```tsx
  it('offers Teams, Bookings, Scrims and Events only to a viewer the competitive switch lets in', () => {
    const inCompetitive = { steamid: '1', name: 'alice', avatar: null, status: 'active', isAdmin: false, teams: true };
    const { unmount } = render(
      <LocationProvider><Nav session={{ kind: 'active', me: inCompetitive }} state={null} /></LocationProvider>,
    );
    expect((screen.getByRole('link', { name: 'Teams' }) as HTMLAnchorElement).getAttribute('href')).toBe('/teams');
    expect((screen.getByRole('link', { name: 'Bookings' }) as HTMLAnchorElement).getAttribute('href')).toBe('/bookings');
    expect((screen.getByRole('link', { name: 'Scrims' }) as HTMLAnchorElement).getAttribute('href')).toBe('/scrims');
    expect((screen.getByRole('link', { name: 'Events' }) as HTMLAnchorElement).getAttribute('href')).toBe('/events');
    unmount();
    const outside = { steamid: '2', name: 'bob', avatar: null, status: 'active', isAdmin: false };
    render(<LocationProvider><Nav session={{ kind: 'active', me: outside }} state={null} /></LocationProvider>);
    expect(screen.queryByRole('link', { name: 'Teams' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Bookings' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Scrims' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Events' })).toBeNull();
  });

  it('keeps Events current on an event page', () => {
    history.replaceState(null, '', '/event/riverside-cup');
    const me = { steamid: '1', name: 'alice', avatar: null, status: 'active', isAdmin: false, teams: true };
    render(<LocationProvider><Nav session={{ kind: 'active', me }} state={null} /></LocationProvider>);
    expect(screen.getByRole('link', { name: 'Events' }).getAttribute('aria-current')).toBe('page');
    history.replaceState(null, '', '/');
  });
```

`tests/eventGating.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import * as E from '../src/events/events.js';
import { must } from './eventFixture.js';

/**
 * Every event route, for every competitive_enabled value and every kind of
 * viewer, in one table. Public routes follow the switch exactly as the team
 * pages do; a draft is staff only and otherwise an ordinary 404; the admin
 * desk ignores the switch, lets staff read and only admins write.
 */

const ADMIN = '76561199000000730';
const MOD = '76561199000000731';
const PLAYER = '76561199000000732';
type Who = 'anon' | 'player' | 'mod' | 'admin';
type Switch = 'off' | 'admins' | 'everyone';
const WHO: Record<Who, string | undefined> = { anon: undefined, player: PLAYER, mod: MOD, admin: ADMIN };

/** Public routes on a published event. */
const PUBLIC: Record<Switch, Record<Who, number>> = {
  off: { anon: 404, player: 404, mod: 404, admin: 404 },
  admins: { anon: 404, player: 404, mod: 404, admin: 200 },
  everyone: { anon: 200, player: 200, mod: 200, admin: 200 },
};
/** The page of a draft: staff, once the switch lets them in at all (under
 *  admins only, a mod is kept out like any player). */
const DRAFT: Record<Switch, Record<Who, number>> = {
  off: { anon: 404, player: 404, mod: 404, admin: 404 },
  admins: { anon: 404, player: 404, mod: 404, admin: 200 },
  everyone: { anon: 404, player: 404, mod: 200, admin: 200 },
};
/** The admin desk, whatever the switch: staff read it, only admins write. */
const DESK_READ: Record<Who, number> = { anon: 401, player: 403, mod: 200, admin: 200 };
const DESK_WRITE: Record<Who, number> = { anon: 401, player: 403, mod: 403, admin: 200 };

let db: DB;
let app: FastifyInstance;
let cookies: Record<string, Record<string, string>>;
let published: E.EventRow;
let draft: E.EventRow;

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({
    config: { ...loadConfig({}), communityDir: mkdtempSync(join(tmpdir(), 'eventgating-')) },
    db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {},
  });
  cookies = {};
  for (const id of [ADMIN, MOD, PLAYER]) cookies[id] = authedCookie(app, db, id);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
  const cup = (db.prepare("SELECT id FROM rulesets WHERE name = 'Standard Cup'").get() as { id: number }).id;
  const startsAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
  published = must(E.createEvent(db, { by: ADMIN, fields: { name: 'Open Cup', startsAt, entryKind: 'team' } }));
  must(E.addStage(db, { eventId: published.id, by: ADMIN, stage: { type: 'single_elim', rulesetId: cup } }));
  must(E.publishEvent(db, { eventId: published.id, by: ADMIN }));
  draft = must(E.createEvent(db, { by: ADMIN, fields: { name: 'Secret Cup', startsAt, entryKind: 'team' } }));
});
afterEach(async () => { await app.close(); });

const setSwitch = (v: Switch) => db.prepare("UPDATE settings SET value = ? WHERE key = 'competitive_enabled'").run(v);
const call = (method: 'GET' | 'POST', url: string, who: Who, payload?: object) => {
  const id = WHO[who];
  return app.inject({ method, url, cookies: id ? cookies[id] : undefined, payload });
};

describe('event route gating', () => {
  for (const sw of ['off', 'admins', 'everyone'] as const) {
    for (const who of ['anon', 'player', 'mod', 'admin'] as const) {
      it(`switch ${sw}, ${who}`, async () => {
        setSwitch(sw);
        expect((await call('GET', '/api/events', who)).statusCode, 'list').toBe(PUBLIC[sw][who]);
        expect((await call('GET', `/api/events/${published.slug}`, who)).statusCode, 'page').toBe(PUBLIC[sw][who]);
        expect((await call('GET', `/api/events/${draft.slug}`, who)).statusCode, 'draft page').toBe(DRAFT[sw][who]);
        for (const url of ['/api/admin/events', '/api/admin/events/options', `/api/admin/events/${draft.id}`]) {
          expect((await call('GET', url, who)).statusCode, url).toBe(DESK_READ[who]);
        }
        if (PUBLIC[sw][who] === 200) {
          const names = (await call('GET', '/api/events', who)).json().events.map((e: { name: string }) => e.name);
          expect(names).toEqual(who === 'admin' || who === 'mod' ? ['Open Cup', 'Secret Cup'] : ['Open Cup']);
        }
      });
    }
  }

  it('no one but an admin changes anything through the desk, and a refused call writes nothing', async () => {
    setSwitch('everyone');
    const before = JSON.stringify([db.prepare('SELECT * FROM events').all(), db.prepare('SELECT COUNT(*) FROM event_log').get()]);
    for (const who of ['anon', 'player', 'mod'] as const) {
      expect((await call('POST', '/api/admin/events', who, { name: 'Sneaky Cup', startsAt: published.starts_at, entryKind: 'team' })).statusCode).toBe(DESK_WRITE[who]);
      expect((await call('POST', `/api/admin/events/${draft.id}/publish`, who)).statusCode).toBe(DESK_WRITE[who]);
      expect((await call('POST', `/api/admin/events/${published.id}/cancel`, who, { reason: 'x' })).statusCode).toBe(DESK_WRITE[who]);
      expect((await call('POST', `/api/admin/events/${published.id}/banner/remove`, who)).statusCode).toBe(DESK_WRITE[who]);
    }
    expect(JSON.stringify([db.prepare('SELECT * FROM events').all(), db.prepare('SELECT COUNT(*) FROM event_log').get()])).toBe(before);
  });
});
```

- [ ] **Step 2: Run the tests to verify which fail**

Run: `npx vitest run web/src/components/Nav.test.tsx tests/eventGating.test.ts`
Expected: the Nav cases FAIL (no Events link). The gating sweep should already PASS against Tasks 4 to 6; if any cell fails, the route that answered wrongly is the bug, fix it there rather than the table.

- [ ] **Step 3: Add the nav link**

In `web/src/components/Nav.tsx`, in `isCurrent`, after the `/bookings` line:

```tsx
  if (href === '/events') return path === '/events' || path.startsWith('/event/');
```

Replace the competitive links block:

```tsx
  // Teams, Bookings and Scrims only for viewers the competitive switch lets in (/api/me teams).
  const links = me?.teams
    ? [...NAV_LINKS.slice(0, 5), ['/teams', 'Teams'] as const, ['/bookings', 'Bookings'] as const, ['/scrims', 'Scrims'] as const, ...NAV_LINKS.slice(5)]
    : NAV_LINKS;
```

with

```tsx
  // Teams, Bookings, Scrims and Events only for viewers the competitive switch lets in (/api/me teams).
  const links = me?.teams
    ? [
      ...NAV_LINKS.slice(0, 5), ['/teams', 'Teams'] as const, ['/bookings', 'Bookings'] as const, ['/scrims', 'Scrims'] as const,
      ['/events', 'Events'] as const, ...NAV_LINKS.slice(5),
    ]
    : NAV_LINKS;
```

- [ ] **Step 4: Run the whole suite, the typecheck and the web build**

Run: `npx vitest run web/src/components/Nav.test.tsx tests/eventGating.test.ts && npm test && npm run typecheck && npm run build`
Expected: every test PASSES, no type errors, the build succeeds.

Then check the plan's no-em-dash rule over everything this plan touched:

Run: `git diff --name-only master... | xargs grep -nP '\x{2014}' || echo clean`
Expected: `clean`.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/Nav.tsx web/src/components/Nav.test.tsx tests/eventGating.test.ts
git commit -m "Events: nav link for competitive viewers, and one gating table over every event route"
```

---

## Self-review notes

- **Spec coverage.** Section 1 event fields and status chain: Task 1 schema, Task 2 rules, Task 3 transitions (only those Ruling 3 implements). Eligibility, check-in and roster JSON: Task 2 parsers, Tasks 7 and 9 editor, Task 10 page lines. Stages (type, config, ruleset snapshot, pool, veto, chapters, scheduling, advance count): Tasks 1 to 3, 9. Section 2 entries and entry players: schema and merge in Task 1, the sweep keeping entry logo snapshots in Task 6, the empty list on the page in Tasks 5 and 10; behaviour is T1b. Section 7 event page: banner (Task 6 backend, Tasks 9 and 10 web), status, countdown, formatted description (Task 8), format strip, rules, pool, entries (empty state); prizes, brackets, schedule and the live strip are later plans (listed under "Not in this plan"). `/events` list with banner thumbnails: Tasks 5 and 10. Error handling, one transaction with an audit row: Task 3 guard tests, extended to the banner in Task 6. Rollout, behind `competitive_enabled`: Tasks 5 and 11. Owner amendments of 2026-10-01: formatter (Ruling 1, Tasks 8 to 10), mods read only (Rulings 2 and 14, Tasks 4, 5, 7, 9, 11), banners (Rulings 4 and 21, Tasks 6, 9, 10).
- **Names used across tasks.** `EventResult`, `must`, `stageBody`, `eventFixture`, `ADMIN`, `NOW` (Task 3) are what Tasks 3, 5, 6 and 11 tests import. `stageSummary` (Task 2) is used by Tasks 4 and 5. `adminEventDetail`, `AdminEvent*` (Task 4, `bannerKey` included) are mirrored in Task 7 `api.ts`. `eventListItems(db, { staff })` (Task 5) is called with `{ staff: isStaff(...) }`. `setEventBanner` (Task 6) is listed in the guard's `MUTATIONS`. `bannerUrl`, `setEventBanner`/`removeEventBanner` on `adminApi` (Task 7) are used by Tasks 9 and 10. `eventAdminUrl` (Task 7) is used by `EventsDesk`. `STATUS_LABEL`, `toLocalInput`, `fromLocalInput`, `untilText`, `whenText` (Task 7) are used by Tasks 9 and 10. `RichText` (Task 8) is used by Tasks 9 and 10. `EventsDesk({ canEdit })` and `EventEditor({ id, canEdit })` get `canEdit={isAdmin}` in `Admin.tsx`.
- **Review Focus tests.** Hostile description text: Task 8 `hostile input` and `shows tags, entities and other schemes as text`, Task 10 `formats the description with the safe subset`. Time round trip: Task 7 `eventFormat.test.ts`. Banners: Task 6 `banner checks`, `banner files`, `banner routes`. Reorder then remove with scrambled row order: Task 3 `numbers stages in order, and renumbers after a reorder and a remove`. Draft probing and mod writes: Task 5 `a draft is the same 404 as an unknown slug`, Task 4 `a mod reads an event ... every write answers 403`, Task 11 gating table and `no one but an admin changes anything`.
- **Checked by running it.** Every code block of this plan was applied to a copy of the repo at 810842e7: `npm run typecheck` (server and web), the full `npx vitest run` and `npm run build` all pass.
