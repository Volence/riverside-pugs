# Social profiles and the streams page: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a player put a bio, pronouns, country and social handles on their profile, link Twitch over OAuth, and add a `/streams` page that tiers linked streamers into "live in a PUG", "live", and "offline".

**Architecture:** Pure validation lives in one dependency-free module (`src/profileFields.ts`) so it can be tested exhaustively without a database or a server. The Twitch integration follows the Discord one exactly: a config block that is `null` when unconfigured, an injectable API interface with a fake for tests, an OAuth route with HMAC state bound to the session, and a background poller registered on the Fastify instance with an `onClose` teardown. The streams read model is one pure-ish function over the DB plus a list of currently-engaged steamids handed in by the caller, so the queue (which lives in memory) never has to be reachable from the query layer.

**Tech Stack:** TypeScript, Fastify 5, better-sqlite3, Preact + preact-iso, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-20-social-profiles-and-streams-design.md`

## Global Constraints

- **Scope is the web app only.** No plugin change, no game server change, no cfg change, no deploy. Work happens on the worktree branch `worktree-social-profiles`.
- **Nothing is deployed** until the owner says so. `deploy-web.sh` is not run by this plan.
- **No em dashes** anywhere: code, comments, commit messages, UI copy.
- **Handles are handles, never URLs.** No code path may render a user-supplied URL. URLs are built from the per-platform template in `LINK_PLATFORMS`.
- **`twitch_id` is canonical, `twitch_name` is a cache.** Never key anything on the login.
- Stat and roster queries filter `m.state = 'completed'` for history and `m.state = 'live'` for now. Voided matches are set to `aborted` and are excluded by both.
- Test command is `npx vitest run <file>`; typecheck is `npm run typecheck` (it checks both tsconfigs).
- Commit after every task. Commit messages follow house style: a sentence-case summary line, blank line, prose explaining why, no trailing attribution footer.

---

### Task 1: Schema and settings

**Files:**
- Modify: `src/db.ts` (SCHEMA string, `DEFAULT_SETTINGS`, `openDb` migration block)
- Test: `tests/db.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: tables `player_links`, `twitch_status`; columns `players.bio`, `players.pronouns`, `players.country`, `players.twitch_id`, `players.twitch_name`; settings `chemistry_min_games`, `endorse_budget`, `endorse_window_hours`, `endorse_title_min`, `endorse_title_min_games`.

Note: the endorsement settings are seeded here rather than in the later endorsements plan, because `seed()` only inserts settings that are missing and doing it once avoids a second pass over the same function.

- [ ] **Step 1: Write the failing test**

Append to `tests/db.test.ts`:

```ts
describe('social profile schema', () => {
  it('players carries the profile and twitch columns', () => {
    const db = openDb(':memory:');
    const cols = (db.prepare('PRAGMA table_info(players)').all() as { name: string }[])
      .map((c) => c.name);
    for (const c of ['bio', 'pronouns', 'country', 'twitch_id', 'twitch_name']) {
      expect(cols).toContain(c);
    }
  });

  it('one twitch channel cannot be claimed by two players', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO players (steamid, name) VALUES ('1', 'a')").run();
    db.prepare("INSERT INTO players (steamid, name) VALUES ('2', 'b')").run();
    db.prepare("UPDATE players SET twitch_id = '999' WHERE steamid = '1'").run();
    expect(() => db.prepare("UPDATE players SET twitch_id = '999' WHERE steamid = '2'").run())
      .toThrow();
  });

  it('unlinked players do not collide on a null twitch_id', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO players (steamid, name) VALUES ('1', 'a')").run();
    db.prepare("INSERT INTO players (steamid, name) VALUES ('2', 'b')").run();
    const n = db.prepare('SELECT COUNT(*) AS n FROM players WHERE twitch_id IS NULL')
      .get() as { n: number };
    expect(n.n).toBe(2);
  });

  it('player_links is one row per player per platform', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO players (steamid, name) VALUES ('1', 'a')").run();
    const ins = db.prepare('INSERT INTO player_links (player_id, platform, handle) VALUES (?,?,?)');
    ins.run('1', 'x', 'alice');
    expect(() => ins.run('1', 'x', 'bob')).toThrow();
    ins.run('1', 'youtube', 'alice');
    const n = db.prepare('SELECT COUNT(*) AS n FROM player_links').get() as { n: number };
    expect(n.n).toBe(2);
  });

  it('twitch_status is one row per player', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO players (steamid, name) VALUES ('1', 'a')").run();
    const ins = db.prepare(
      'INSERT INTO twitch_status (player_id, is_live, checked_at) VALUES (?,?,?)',
    );
    ins.run('1', 1, '2026-09-20T00:00:00Z');
    expect(() => ins.run('1', 0, '2026-09-20T00:01:00Z')).toThrow();
  });

  it('seeds the social settings', () => {
    const db = openDb(':memory:');
    const get = (k: string) =>
      (db.prepare('SELECT value FROM settings WHERE key = ?').get(k) as { value: string } | undefined)?.value;
    expect(get('chemistry_min_games')).toBe('5');
    expect(get('endorse_budget')).toBe('2');
    expect(get('endorse_window_hours')).toBe('24');
    expect(get('endorse_title_min')).toBe('5');
    expect(get('endorse_title_min_games')).toBe('10');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/db.test.ts`
Expected: FAIL, no such column `bio`, no such table `player_links`.

- [ ] **Step 3: Add the tables to `SCHEMA`**

In `src/db.ts`, inside the `SCHEMA` template string, after the `player_networks` area is not possible (that one is created in `openDb`), so add these near the other `CREATE TABLE` statements, after `players`:

```sql
-- A player's off-site presence. Handles, never URLs: the URL is generated
-- server-side from a per-platform template, so there is no code path that
-- renders a link a player typed. On a public site that has already had one
-- identity forgery bug, a free URL field is somewhere to hang a phishing link.
--
-- Deliberately no CHECK on `platform`, unlike most of this schema. SQLite
-- cannot alter a CHECK without rebuilding the table, which would make adding a
-- platform exactly the migration this table exists to avoid. The permitted set
-- lives in LINK_PLATFORMS in src/profileFields.ts, which has to be correct
-- anyway because it also builds the URLs.
CREATE TABLE IF NOT EXISTS player_links (
  player_id TEXT NOT NULL REFERENCES players(steamid),
  platform  TEXT NOT NULL,
  handle    TEXT NOT NULL,
  PRIMARY KEY (player_id, platform)
);
-- The Twitch poll cache, overwritten every minute. Separate from `players` on
-- purpose: this is volatile data on a hot write path, and it must never touch
-- the row where identity, admin flag and ban status live.
--
-- `checked_at` is always written, even when nothing changed, because the read
-- path uses it to decide the cache is too stale to claim anyone is live. A
-- LIVE badge stuck on forever after the poller dies would make the whole page
-- untrustworthy; a wrong "offline" is a shrug.
CREATE TABLE IF NOT EXISTS twitch_status (
  player_id    TEXT PRIMARY KEY REFERENCES players(steamid),
  is_live      INTEGER NOT NULL DEFAULT 0,
  title        TEXT,
  game_name    TEXT,
  viewers      INTEGER,
  thumbnail    TEXT,
  started_at   TEXT,
  last_live_at TEXT,
  checked_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_twitch_status_live ON twitch_status (is_live, viewers DESC);
```

- [ ] **Step 4: Add the columns and the index in `openDb`**

In `src/db.ts`, in the `ensureColumn` block in `openDb`, after the Discord identity lines:

```ts
  // Player-authored profile fields. All three are constrained rather than
  // trusted: see src/profileFields.ts. They are columns rather than rows in
  // player_links because they are one-per-player and are rendered with the
  // name itself rather than as a list.
  ensureColumn(db, 'players', 'bio', 'TEXT');
  ensureColumn(db, 'players', 'pronouns', 'TEXT');
  ensureColumn(db, 'players', 'country', 'TEXT');
  // Twitch identity. The id is canonical and the login is a cache: Twitch
  // logins change and ids do not, so every lookup and every unique constraint
  // keys on the id. Partial index for the same reason as discord_id: almost
  // every row is NULL and NULLs must not collide.
  ensureColumn(db, 'players', 'twitch_id', 'TEXT');
  ensureColumn(db, 'players', 'twitch_name', 'TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS players_twitch_id ON players(twitch_id) WHERE twitch_id IS NOT NULL');
```

- [ ] **Step 5: Add the settings**

In `DEFAULT_SETTINGS` in `src/db.ts`:

```ts
  // Minimum shared matches before a with/against win rate is worth showing.
  // Its own knob rather than a reuse of standing_min_games for the reason
  // given in 5d2ae85: "we have played five together" and "is your per-match
  // average meaningful" are different questions with different answers.
  chemistry_min_games: '5',
  // Endorsements a player may give per match, and how long after the match
  // ends giving stays open. The window exists so a pair cannot decide one
  // evening to farm every match they have ever played together.
  endorse_budget: '2',
  endorse_window_hours: '24',
  // Before a kind becomes a visible title: that many endorsements of the kind,
  // and that many matches played at all.
  endorse_title_min: '5',
  endorse_title_min_games: '10',
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/db.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add src/db.ts tests/db.test.ts
git commit -m "Add the schema for profile fields, social links and Twitch status

player_links has no CHECK on platform, unlike most of this schema, because
SQLite cannot alter one without rebuilding the table. That would make adding a
platform the migration the table exists to avoid. The permitted set lives in
LINK_PLATFORMS, which has to be right anyway since it also builds the URLs.

twitch_status is its own table rather than columns on players: it is rewritten
every minute by a poller, and that write path should never touch the row
holding identity, the admin flag and ban state. checked_at is written on every
poll so the read path can refuse to claim anyone is live from a stale cache."
```

---

### Task 2: Country list

**Files:**
- Create: `src/countries.ts`
- Test: `tests/countries.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `COUNTRY_CODES: readonly string[]`, `isCountryCode(raw: string): boolean`, `countryName(code: string): string`, `countryFlag(code: string): string`.

- [ ] **Step 1: Write the failing test**

Create `tests/countries.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { COUNTRY_CODES, countryFlag, countryName, isCountryCode } from '../src/countries.js';

describe('countries', () => {
  it('holds the whole ISO 3166-1 alpha-2 set', () => {
    expect(COUNTRY_CODES.length).toBeGreaterThan(240);
    expect(COUNTRY_CODES).toContain('US');
    expect(COUNTRY_CODES).toContain('GB');
    expect(COUNTRY_CODES).toContain('BR');
  });

  it('every code is two uppercase letters and unique', () => {
    for (const c of COUNTRY_CODES) expect(c).toMatch(/^[A-Z]{2}$/);
    expect(new Set(COUNTRY_CODES).size).toBe(COUNTRY_CODES.length);
  });

  it('accepts a real code in any case and rejects anything else', () => {
    expect(isCountryCode('us')).toBe(true);
    expect(isCountryCode('US')).toBe(true);
    expect(isCountryCode('ZZ')).toBe(false);
    expect(isCountryCode('USA')).toBe(false);
    expect(isCountryCode('')).toBe(false);
    expect(isCountryCode('<script>')).toBe(false);
  });

  it('names a country, falling back to the code', () => {
    expect(countryName('US')).toBe('United States');
    // Never throws and never returns empty, whatever ICU has available.
    for (const c of COUNTRY_CODES) expect(countryName(c).length).toBeGreaterThan(0);
  });

  it('renders a flag from regional indicators', () => {
    expect(countryFlag('US')).toBe('\u{1F1FA}\u{1F1F8}');
    expect(countryFlag('GB')).toBe('\u{1F1EC}\u{1F1E7}');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/countries.test.ts`
Expected: FAIL, cannot find module `../src/countries.js`.

- [ ] **Step 3: Write the implementation**

Create `src/countries.ts`:

```ts
/**
 * ISO 3166-1 alpha-2, as a closed list.
 *
 * The country field is a picker, not free text, and this is what closes it.
 * Names come from Intl rather than being written out here: the list of codes
 * is stable and short, the list of names is neither, and a Node built without
 * full ICU falls back to the code rather than to nothing.
 */
const CODES =
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS '
  + 'BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE '
  + 'EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM '
  + 'HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC '
  + 'LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA '
  + 'NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW '
  + 'SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO '
  + 'TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW';

export const COUNTRY_CODES: readonly string[] = Object.freeze(CODES.split(' '));

const CODE_SET = new Set(COUNTRY_CODES);

export function isCountryCode(raw: string): boolean {
  return typeof raw === 'string' && CODE_SET.has(raw.toUpperCase());
}

let display: Intl.DisplayNames | null = null;
try {
  display = new Intl.DisplayNames(['en'], { type: 'region' });
} catch {
  display = null; // Node without full ICU. Codes are shown instead of names.
}

export function countryName(code: string): string {
  const up = code.toUpperCase();
  try {
    return display?.of(up) ?? up;
  } catch {
    return up;
  }
}

/** The flag emoji, which is just the code as two regional indicator symbols. */
export function countryFlag(code: string): string {
  const up = code.toUpperCase();
  if (!CODE_SET.has(up)) return '';
  const base = 0x1f1e6 - 'A'.charCodeAt(0);
  return String.fromCodePoint(base + up.charCodeAt(0), base + up.charCodeAt(1));
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/countries.test.ts`
Expected: PASS. If `countryName('US')` returns `'US'`, this Node lacks full ICU; that is a valid fallback but the test asserts the name, so check `node -e "console.log(new Intl.DisplayNames(['en'],{type:'region'}).of('US'))"` before changing the implementation.

- [ ] **Step 5: Commit**

```bash
git add src/countries.ts tests/countries.test.ts
git commit -m "Close the country field to the ISO 3166-1 alpha-2 list

Country is a picker, not free text, and this is the list that closes it. Codes
are written out because the set is stable and short; names come from Intl
because they are neither, and a Node without full ICU degrades to showing the
code rather than to showing nothing."
```

---

### Task 3: Profile field validation

**Files:**
- Create: `src/profileFields.ts`
- Test: `tests/profileFields.test.ts`

**Interfaces:**
- Consumes: `isCountryCode` from `src/countries.ts`.
- Produces:
  - `LINK_PLATFORMS: readonly LinkPlatform[]` where `LinkPlatform = { key: string; label: string; placeholder: string; normalize(raw: string): string | null; url(handle: string): string }`
  - `PLATFORM_KEYS: readonly string[]`
  - `isPlatform(key: string): boolean`
  - `linkUrl(platform: string, handle: string): string | null`
  - `validateBio(raw: unknown): Validated`
  - `validatePronouns(raw: unknown): Validated`
  - `validateCountry(raw: unknown): Validated`
  - `validateHandle(platform: string, raw: unknown): Validated`
  - `type Validated = { ok: true; value: string | null } | { ok: false; error: string }`

  A `value` of `null` means "the player cleared this field", which is always allowed.

- [ ] **Step 1: Write the failing test**

Create `tests/profileFields.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  LINK_PLATFORMS, PLATFORM_KEYS, isPlatform, linkUrl,
  validateBio, validateCountry, validateHandle, validatePronouns,
} from '../src/profileFields.js';

describe('platforms', () => {
  it('knows exactly the four platforms', () => {
    expect([...PLATFORM_KEYS]).toEqual(['youtube', 'x', 'bluesky', 'tiktok']);
    expect(isPlatform('youtube')).toBe(true);
    expect(isPlatform('myspace')).toBe(false);
    expect(isPlatform('__proto__')).toBe(false);
  });

  it('builds every URL from a template, never from input', () => {
    expect(linkUrl('youtube', 'alice')).toBe('https://www.youtube.com/@alice');
    expect(linkUrl('x', 'alice')).toBe('https://x.com/alice');
    expect(linkUrl('bluesky', 'alice.bsky.social')).toBe('https://bsky.app/profile/alice.bsky.social');
    expect(linkUrl('tiktok', 'alice')).toBe('https://www.tiktok.com/@alice');
    expect(linkUrl('myspace', 'alice')).toBe(null);
  });

  it('every platform url is https and on its own host', () => {
    for (const p of LINK_PLATFORMS) {
      const u = new URL(p.url('someone'));
      expect(u.protocol).toBe('https:');
    }
  });
});

describe('validateHandle', () => {
  it('strips a leading @ and keeps the rest', () => {
    expect(validateHandle('x', '@alice')).toEqual({ ok: true, value: 'alice' });
    expect(validateHandle('x', ' alice ')).toEqual({ ok: true, value: 'alice' });
  });

  it('treats empty as clearing the field', () => {
    expect(validateHandle('x', '')).toEqual({ ok: true, value: null });
    expect(validateHandle('x', '   ')).toEqual({ ok: true, value: null });
    expect(validateHandle('x', null)).toEqual({ ok: true, value: null });
  });

  it('refuses a URL, which is the whole point of the field', () => {
    expect(validateHandle('x', 'https://x.com/alice').ok).toBe(false);
    expect(validateHandle('x', 'x.com/alice').ok).toBe(false);
    expect(validateHandle('youtube', 'javascript:alert(1)').ok).toBe(false);
  });

  it('refuses path and protocol characters that could escape the template', () => {
    for (const bad of ['a/b', 'a?b', 'a#b', 'a b', 'a\\b', 'a:b', '..', 'a%2Fb', 'a<b']) {
      expect(validateHandle('x', bad).ok).toBe(false);
    }
  });

  it('enforces each platform pattern', () => {
    expect(validateHandle('x', 'a'.repeat(15)).ok).toBe(true);
    expect(validateHandle('x', 'a'.repeat(16)).ok).toBe(false);
    expect(validateHandle('youtube', 'ab').ok).toBe(false);
    expect(validateHandle('youtube', 'a'.repeat(30)).ok).toBe(true);
    expect(validateHandle('bluesky', 'alice.bsky.social').ok).toBe(true);
    expect(validateHandle('tiktok', 'al.ice_1').ok).toBe(true);
  });

  it('refuses an unknown platform', () => {
    expect(validateHandle('myspace', 'alice').ok).toBe(false);
  });
});

describe('validateBio', () => {
  it('trims and keeps plain text', () => {
    expect(validateBio('  hi there  ')).toEqual({ ok: true, value: 'hi there' });
  });

  it('treats empty as clearing', () => {
    expect(validateBio('')).toEqual({ ok: true, value: null });
    expect(validateBio(null)).toEqual({ ok: true, value: null });
  });

  it('caps at 200 characters', () => {
    expect(validateBio('a'.repeat(200)).ok).toBe(true);
    expect(validateBio('a'.repeat(201)).ok).toBe(false);
  });

  it('refuses anything that looks like a link', () => {
    for (const bad of [
      'see https://evil.test',
      'see http://evil.test',
      'go to www.evil.test',
      'find me at evil.gg',
      'steamcommunity.com/id/x',
      'javascript:alert(1)',
    ]) {
      expect(validateBio(bad).ok).toBe(false);
    }
  });

  it('does not mistake ordinary prose for a link', () => {
    expect(validateBio('i main hunter. no u.').ok).toBe(true);
    expect(validateBio('gg wp. 3.5 kd btw').ok).toBe(true);
  });

  it('refuses control characters and newlines', () => {
    expect(validateBio('a\nb').ok).toBe(false);
    expect(validateBio('a b').ok).toBe(false);
    expect(validateBio('a‮b').ok).toBe(false);
  });
});

describe('validatePronouns', () => {
  it('accepts the ordinary forms', () => {
    expect(validatePronouns('they/them')).toEqual({ ok: true, value: 'they/them' });
    expect(validatePronouns('she/her')).toEqual({ ok: true, value: 'she/her' });
    expect(validatePronouns('any')).toEqual({ ok: true, value: 'any' });
  });

  it('treats empty as clearing', () => {
    expect(validatePronouns('')).toEqual({ ok: true, value: null });
  });

  it('caps at 24 characters and refuses markup', () => {
    expect(validatePronouns('a'.repeat(25)).ok).toBe(false);
    expect(validatePronouns('<b>they</b>').ok).toBe(false);
    expect(validatePronouns('they\nthem').ok).toBe(false);
  });
});

describe('validateCountry', () => {
  it('uppercases a real code', () => {
    expect(validateCountry('us')).toEqual({ ok: true, value: 'US' });
  });

  it('treats empty as clearing', () => {
    expect(validateCountry('')).toEqual({ ok: true, value: null });
  });

  it('refuses anything not on the list', () => {
    expect(validateCountry('ZZ').ok).toBe(false);
    expect(validateCountry('USA').ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/profileFields.test.ts`
Expected: FAIL, cannot find module `../src/profileFields.js`.

- [ ] **Step 3: Write the implementation**

Create `src/profileFields.ts`:

```ts
import { isCountryCode } from './countries.js';

export type Validated =
  | { ok: true; value: string | null }
  | { ok: false; error: string };

const ok = (value: string | null): Validated => ({ ok: true, value });
const bad = (error: string): Validated => ({ ok: false, error });

export interface LinkPlatform {
  key: string;
  label: string;
  placeholder: string;
  /** The shape a handle must have on this platform, after the @ is stripped. */
  pattern: RegExp;
  url(handle: string): string;
}

/**
 * The closed set of off-site platforms, and how to turn a handle into a link.
 *
 * This is the only place a profile URL is ever constructed. Nothing stores or
 * renders a URL a player typed, which is what makes it structurally impossible
 * to hang a phishing link off a public profile rather than a rule somebody has
 * to remember to enforce.
 *
 * Every pattern excludes '/', ':', '?', '#', '%', '.' where the platform does
 * not need it, and whitespace, so a handle can never carry the template into
 * another path or another host.
 */
export const LINK_PLATFORMS: readonly LinkPlatform[] = Object.freeze([
  {
    key: 'youtube',
    label: 'YouTube',
    placeholder: '@handle',
    pattern: /^[A-Za-z0-9._-]{3,30}$/,
    url: (h) => `https://www.youtube.com/@${h}`,
  },
  {
    key: 'x',
    label: 'X',
    placeholder: '@handle',
    pattern: /^[A-Za-z0-9_]{1,15}$/,
    url: (h) => `https://x.com/${h}`,
  },
  {
    // The only platform where dots are part of the handle, because a Bluesky
    // handle is a domain name.
    key: 'bluesky',
    label: 'Bluesky',
    placeholder: 'name.bsky.social',
    pattern: /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/,
    url: (h) => `https://bsky.app/profile/${h}`,
  },
  {
    key: 'tiktok',
    label: 'TikTok',
    placeholder: '@handle',
    pattern: /^[A-Za-z0-9._]{2,24}$/,
    url: (h) => `https://www.tiktok.com/@${h}`,
  },
]);

export const PLATFORM_KEYS: readonly string[] =
  Object.freeze(LINK_PLATFORMS.map((p) => p.key));

// A Map rather than an object literal, so a key like '__proto__' or
// 'constructor' cannot resolve to something inherited.
const BY_KEY = new Map(LINK_PLATFORMS.map((p) => [p.key, p]));

export function isPlatform(key: string): boolean {
  return BY_KEY.has(key);
}

export function linkUrl(platform: string, handle: string): string | null {
  return BY_KEY.get(platform)?.url(handle) ?? null;
}

/** Text a player may not put anywhere: control characters, and the bidi
 *  overrides that let a string render as something other than what it is. */
const UNSAFE_CHARS = /[ -​-‏  ‪-‮⁦-⁩]/;

/** Anything link-shaped. Deliberately broad, because the bio is prose and a
 *  false positive costs somebody one rephrase, while a false negative puts a
 *  clickable-looking domain on a public page. */
const LINKISH = /(?:[a-z][a-z0-9+.-]*:)|(?:\bwww\.)|(?:[a-z0-9-]+\.(?:com|net|org|gg|io|tv|co|me|xyz|link|ru|cn|info|biz|top|site|live|app|dev|gl|ly))\b/i;

function asString(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

export function validateBio(raw: unknown): Validated {
  if (raw !== null && raw !== undefined && typeof raw !== 'string') return bad('bio must be text');
  const v = asString(raw);
  if (v === null) return ok(null);
  if (v.length > 200) return bad('bio is limited to 200 characters');
  if (UNSAFE_CHARS.test(v)) return bad('bio must be a single line of plain text');
  if (LINKISH.test(v)) return bad('bio cannot contain links. Use the social fields instead.');
  return ok(v);
}

export function validatePronouns(raw: unknown): Validated {
  if (raw !== null && raw !== undefined && typeof raw !== 'string') return bad('pronouns must be text');
  const v = asString(raw);
  if (v === null) return ok(null);
  if (v.length > 24) return bad('pronouns are limited to 24 characters');
  if (!/^[A-Za-z][A-Za-z/ '-]*$/.test(v)) return bad('pronouns may only use letters, spaces and slashes');
  return ok(v);
}

export function validateCountry(raw: unknown): Validated {
  if (raw !== null && raw !== undefined && typeof raw !== 'string') return bad('country must be text');
  const v = asString(raw);
  if (v === null) return ok(null);
  if (!isCountryCode(v)) return bad('country must be a two letter country code');
  return ok(v.toUpperCase());
}

export function validateHandle(platform: string, raw: unknown): Validated {
  const p = BY_KEY.get(platform);
  if (!p) return bad('unknown platform');
  if (raw !== null && raw !== undefined && typeof raw !== 'string') return bad('handle must be text');
  const trimmed = asString(raw);
  if (trimmed === null) return ok(null);
  // One leading @ is how people write these, everywhere. Anything past that is
  // not a handle.
  const v = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
  if (v === '') return ok(null);
  if (UNSAFE_CHARS.test(v)) return bad(`that is not a ${p.label} handle`);
  if (!p.pattern.test(v)) return bad(`that is not a ${p.label} handle`);
  return ok(v);
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/profileFields.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/profileFields.ts tests/profileFields.test.ts
git commit -m "Validate the profile fields, and build every social URL from a template

LINK_PLATFORMS is the only place a profile URL is ever constructed. Nothing
stores or renders a URL a player typed, so a phishing link on a public profile
is impossible by construction rather than by a rule somebody has to remember.
Every handle pattern excludes the characters that could carry a handle out of
its template into another path or another host, and the tests pin those.

The bio's link detector is deliberately broad. A false positive costs one
rephrase; a false negative puts a clickable-looking domain on a public page.

Platforms resolve through a Map, so '__proto__' is a miss rather than an
inherited object."
```

---

### Task 4: Reading and writing profile fields

**Files:**
- Modify: `src/players.ts`
- Test: `tests/profileWrite.test.ts` (create)

**Interfaces:**
- Consumes: `validateBio`, `validatePronouns`, `validateCountry`, `validateHandle`, `LINK_PLATFORMS`, `linkUrl` from `src/profileFields.ts`.
- Produces, exported from `src/players.ts`:
  - `interface ProfileFields { bio: string | null; pronouns: string | null; country: string | null; links: Record<string, string> }`
  - `interface SocialLink { platform: string; label: string; handle: string; url: string }`
  - `getProfileFields(db: DB, steamid: string): ProfileFields`
  - `socialLinks(db: DB, steamid: string): SocialLink[]`
  - `saveProfileFields(db: DB, steamid: string, input: unknown): { ok: true } | { ok: false; error: string }`
  - `linkTwitch(db: DB, steamid: string, twitchId: string, twitchName: string): { ok: boolean }`
  - `unlinkTwitch(db: DB, steamid: string): void`

- [ ] **Step 1: Write the failing test**

Create `tests/profileWrite.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import {
  getProfileFields, linkTwitch, saveProfileFields, socialLinks, unlinkTwitch, upsertPlayer,
} from '../src/players.js';

const P1 = '76561198000000001';
const P2 = '76561198000000002';
let db: DB;

beforeEach(() => {
  db = openDb(':memory:');
  upsertPlayer(db, P1, 'alice', null);
  upsertPlayer(db, P2, 'bob', null);
});

describe('saveProfileFields', () => {
  it('starts empty', () => {
    expect(getProfileFields(db, P1)).toEqual({ bio: null, pronouns: null, country: null, links: {} });
  });

  it('saves and reads back every field', () => {
    const r = saveProfileFields(db, P1, {
      bio: 'i main hunter', pronouns: 'they/them', country: 'us',
      links: { x: '@alice', youtube: 'alicetv' },
    });
    expect(r.ok).toBe(true);
    expect(getProfileFields(db, P1)).toEqual({
      bio: 'i main hunter', pronouns: 'they/them', country: 'US',
      links: { x: 'alice', youtube: 'alicetv' },
    });
  });

  it('rejects the whole write when any field is invalid, changing nothing', () => {
    saveProfileFields(db, P1, { bio: 'good', links: {} });
    const r = saveProfileFields(db, P1, { bio: 'visit evil.gg', pronouns: 'they/them', links: {} });
    expect(r.ok).toBe(false);
    expect(getProfileFields(db, P1).bio).toBe('good');
    expect(getProfileFields(db, P1).pronouns).toBe(null);
  });

  it('rejects an unknown platform', () => {
    expect(saveProfileFields(db, P1, { links: { myspace: 'alice' } }).ok).toBe(false);
  });

  it('clears a field with an empty string', () => {
    saveProfileFields(db, P1, { bio: 'hello', links: { x: 'alice' } });
    saveProfileFields(db, P1, { bio: '', links: { x: '' } });
    expect(getProfileFields(db, P1)).toEqual({ bio: null, pronouns: null, country: null, links: {} });
  });

  it('leaves other players alone', () => {
    saveProfileFields(db, P1, { bio: 'mine', links: { x: 'alice' } });
    expect(getProfileFields(db, P2)).toEqual({ bio: null, pronouns: null, country: null, links: {} });
  });
});

describe('socialLinks', () => {
  it('returns a built URL per saved handle, in platform order', () => {
    saveProfileFields(db, P1, { links: { tiktok: 'alice', x: 'alice' } });
    expect(socialLinks(db, P1)).toEqual([
      { platform: 'x', label: 'X', handle: 'alice', url: 'https://x.com/alice' },
      { platform: 'tiktok', label: 'TikTok', handle: 'alice', url: 'https://www.tiktok.com/@alice' },
    ]);
  });

  it('ignores a row whose platform is no longer known', () => {
    db.prepare('INSERT INTO player_links (player_id, platform, handle) VALUES (?,?,?)')
      .run(P1, 'myspace', 'alice');
    expect(socialLinks(db, P1)).toEqual([]);
  });
});

describe('twitch link', () => {
  it('links and unlinks', () => {
    expect(linkTwitch(db, P1, '999', 'alicetv').ok).toBe(true);
    const row = db.prepare('SELECT twitch_id, twitch_name FROM players WHERE steamid = ?').get(P1);
    expect(row).toEqual({ twitch_id: '999', twitch_name: 'alicetv' });
    unlinkTwitch(db, P1);
    expect(db.prepare('SELECT twitch_id FROM players WHERE steamid = ?').get(P1))
      .toEqual({ twitch_id: null });
  });

  it('refuses a channel another player already holds', () => {
    linkTwitch(db, P1, '999', 'alicetv');
    expect(linkTwitch(db, P2, '999', 'alicetv').ok).toBe(false);
    expect(db.prepare('SELECT twitch_id FROM players WHERE steamid = ?').get(P2))
      .toEqual({ twitch_id: null });
  });

  it('relinking the same channel to the same player is fine', () => {
    linkTwitch(db, P1, '999', 'alicetv');
    expect(linkTwitch(db, P1, '999', 'alice_tv').ok).toBe(true);
  });

  it('unlinking drops the cached status row', () => {
    linkTwitch(db, P1, '999', 'alicetv');
    db.prepare('INSERT INTO twitch_status (player_id, is_live, checked_at) VALUES (?,1,?)')
      .run(P1, '2026-09-20T00:00:00Z');
    unlinkTwitch(db, P1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM twitch_status').get()).toEqual({ n: 0 });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/profileWrite.test.ts`
Expected: FAIL, `getProfileFields` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/players.ts`, and add the import at the top:

```ts
import {
  LINK_PLATFORMS, isPlatform, linkUrl,
  validateBio, validateCountry, validateHandle, validatePronouns,
} from './profileFields.js';
```

```ts
export interface ProfileFields {
  bio: string | null;
  pronouns: string | null;
  country: string | null;
  /** platform key -> handle, only for platforms the player actually filled in. */
  links: Record<string, string>;
}

export interface SocialLink {
  platform: string;
  label: string;
  handle: string;
  url: string;
}

export function getProfileFields(db: DB, steamid: string): ProfileFields {
  const row = db.prepare('SELECT bio, pronouns, country FROM players WHERE steamid = ?')
    .get(steamid) as { bio: string | null; pronouns: string | null; country: string | null } | undefined;
  const links: Record<string, string> = {};
  const rows = db.prepare('SELECT platform, handle FROM player_links WHERE player_id = ?')
    .all(steamid) as { platform: string; handle: string }[];
  for (const r of rows) links[r.platform] = r.handle;
  return {
    bio: row?.bio ?? null,
    pronouns: row?.pronouns ?? null,
    country: row?.country ?? null,
    links,
  };
}

/** The saved handles as links, in LINK_PLATFORMS order so the chips on a
 *  profile do not reorder themselves between page loads. A row whose platform
 *  is no longer known is skipped rather than guessed at. */
export function socialLinks(db: DB, steamid: string): SocialLink[] {
  const { links } = getProfileFields(db, steamid);
  const out: SocialLink[] = [];
  for (const p of LINK_PLATFORMS) {
    const handle = links[p.key];
    if (!handle) continue;
    const url = linkUrl(p.key, handle);
    if (!url) continue;
    out.push({ platform: p.key, label: p.label, handle, url });
  }
  return out;
}

/**
 * Validate and save a player's own profile fields.
 *
 * All or nothing, inside a transaction. A form where one bad field silently
 * discards the others while keeping the rest is worse than one that refuses:
 * the player cannot see which half landed.
 */
export function saveProfileFields(
  db: DB,
  steamid: string,
  input: unknown,
): { ok: true } | { ok: false; error: string } {
  if (typeof input !== 'object' || input === null) return { ok: false, error: 'invalid body' };
  const body = input as Record<string, unknown>;

  const bio = validateBio(body.bio);
  if (!bio.ok) return { ok: false, error: bio.error };
  const pronouns = validatePronouns(body.pronouns);
  if (!pronouns.ok) return { ok: false, error: pronouns.error };
  const country = validateCountry(body.country);
  if (!country.ok) return { ok: false, error: country.error };

  const rawLinks = body.links;
  if (rawLinks !== undefined && (typeof rawLinks !== 'object' || rawLinks === null)) {
    return { ok: false, error: 'invalid links' };
  }
  const handles: { platform: string; handle: string | null }[] = [];
  for (const [platform, raw] of Object.entries((rawLinks ?? {}) as Record<string, unknown>)) {
    if (!isPlatform(platform)) return { ok: false, error: `unknown platform: ${platform}` };
    const v = validateHandle(platform, raw);
    if (!v.ok) return { ok: false, error: v.error };
    handles.push({ platform, handle: v.value });
  }

  const write = db.transaction(() => {
    db.prepare('UPDATE players SET bio = ?, pronouns = ?, country = ? WHERE steamid = ?')
      .run(bio.value, pronouns.value, country.value, steamid);
    const del = db.prepare('DELETE FROM player_links WHERE player_id = ? AND platform = ?');
    const put = db.prepare(
      `INSERT INTO player_links (player_id, platform, handle) VALUES (?,?,?)
       ON CONFLICT(player_id, platform) DO UPDATE SET handle = excluded.handle`,
    );
    for (const { platform, handle } of handles) {
      if (handle === null) del.run(steamid, platform);
      else put.run(steamid, platform, handle);
    }
  });
  write();
  return { ok: true };
}

/** Attach a Twitch channel. Fails when another player already holds it, which
 *  the partial unique index enforces; relinking your own is fine. */
export function linkTwitch(
  db: DB,
  steamid: string,
  twitchId: string,
  twitchName: string,
): { ok: boolean } {
  const owner = db.prepare('SELECT steamid FROM players WHERE twitch_id = ?').get(twitchId) as
    | { steamid: string } | undefined;
  if (owner && owner.steamid !== steamid) return { ok: false };
  db.prepare('UPDATE players SET twitch_id = ?, twitch_name = ? WHERE steamid = ?')
    .run(twitchId, twitchName, steamid);
  return { ok: true };
}

/** The single off switch: no id, no cached status, so no listing anywhere. */
export function unlinkTwitch(db: DB, steamid: string): void {
  const drop = db.transaction(() => {
    db.prepare('UPDATE players SET twitch_id = NULL, twitch_name = NULL WHERE steamid = ?').run(steamid);
    db.prepare('DELETE FROM twitch_status WHERE player_id = ?').run(steamid);
  });
  drop();
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/profileWrite.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/players.ts tests/profileWrite.test.ts
git commit -m "Read and write the player-authored profile fields

saveProfileFields is all or nothing inside a transaction. A form where one bad
field silently drops while the rest save is worse than one that refuses: the
player cannot see which half landed.

unlinkTwitch drops the cached status row as well as the id, so unlinking is
the single off switch for every surface rather than something that leaves a
stale row behind to be listed."
```

---

### Task 5: Profile API, read and write

**Files:**
- Modify: `src/playerQueries.ts` (add fields to `profileData`)
- Modify: `src/routes/stats.ts` (add `POST /api/profile`)
- Modify: `web/src/api.ts` (types and client calls)
- Test: `tests/profileApi.test.ts` (create)

**Interfaces:**
- Consumes: `getProfileFields`, `socialLinks`, `saveProfileFields` from `src/players.ts`.
- Produces:
  - `profileData` return value gains `player.bio`, `player.pronouns`, `player.country`, `player.twitchName`, and `social: SocialLink[]`.
  - Route `POST /api/profile`, session required, body `{ bio, pronouns, country, links }`, returns `{ ok: true }` or 400 `{ error }`.
  - `web/src/api.ts` gains `api.saveProfile(body)` and the matching `Profile['player']` fields plus `Profile['social']`.

- [ ] **Step 1: Write the failing test**

Create `tests/profileApi.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { upsertPlayer } from '../src/players.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

const P1 = '76561198000000001';
const P2 = '76561198000000002';
let db: DB;
let app: FastifyInstance;

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({
    config: loadConfig({}), db, orchestrator: stubOrchestrator(),
    verifyLogin: async () => P1,
    fetchPersona: async () => ({ name: 'alice', avatar: null }),
    serverExec: async () => {},
  });
  upsertPlayer(db, P1, 'alice', null);
  upsertPlayer(db, P2, 'bob', null);
});
afterEach(async () => { await app.close(); });

describe('POST /api/profile', () => {
  it('needs a session', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/profile', payload: { bio: 'hi' } });
    expect(res.statusCode).toBe(401);
  });

  it('saves the signed-in player their own fields', async () => {
    const cookies = authedCookie(app, db, P1);
    const res = await app.inject({
      method: 'POST', url: '/api/profile', cookies,
      payload: { bio: 'i main hunter', pronouns: 'they/them', country: 'us', links: { x: '@alice' } },
    });
    expect(res.statusCode).toBe(200);
    const prof = await app.inject({ method: 'GET', url: `/api/profile/${P1}` });
    const body = prof.json();
    expect(body.player.bio).toBe('i main hunter');
    expect(body.player.pronouns).toBe('they/them');
    expect(body.player.country).toBe('US');
    expect(body.social).toEqual([
      { platform: 'x', label: 'X', handle: 'alice', url: 'https://x.com/alice' },
    ]);
  });

  it('refuses a link in the bio with a message the form can show', async () => {
    const cookies = authedCookie(app, db, P1);
    const res = await app.inject({
      method: 'POST', url: '/api/profile', cookies, payload: { bio: 'visit evil.gg' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/links/i);
  });

  it('writes only to the caller, whatever the body says', async () => {
    const cookies = authedCookie(app, db, P1);
    await app.inject({
      method: 'POST', url: '/api/profile', cookies,
      payload: { steamid: P2, bio: 'not bobs' },
    });
    const bob = await app.inject({ method: 'GET', url: `/api/profile/${P2}` });
    expect(bob.json().player.bio).toBe(null);
  });

  it('exposes twitchName on a profile once linked', async () => {
    db.prepare("UPDATE players SET twitch_id = '9', twitch_name = 'alicetv' WHERE steamid = ?").run(P1);
    const prof = await app.inject({ method: 'GET', url: `/api/profile/${P1}` });
    expect(prof.json().player.twitchName).toBe('alicetv');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/profileApi.test.ts`
Expected: FAIL, 404 on `POST /api/profile`.

- [ ] **Step 3: Extend `profileData`**

In `src/playerQueries.ts`, import the helpers:

```ts
import { getProfileFields, socialLinks } from './players.js';
```

Then in `profileData`, find the returned object's `player` key and extend it. The existing shape is `player: { steamid, name, avatar, createdAt }`; add the four fields and the top-level `social`:

```ts
  const fields = getProfileFields(db, steamid);
  const twitch = db.prepare('SELECT twitch_name FROM players WHERE steamid = ?')
    .get(steamid) as { twitch_name: string | null } | undefined;
```

and in the returned object:

```ts
    player: {
      steamid: player.steamid,
      name: player.name,
      avatar: player.avatar,
      createdAt: player.created_at,
      bio: fields.bio,
      pronouns: fields.pronouns,
      country: fields.country,
      twitchName: twitch?.twitch_name ?? null,
    },
    social: socialLinks(db, steamid),
```

Keep every other key of the returned object exactly as it is. If the existing `player` object is spread from `player` rather than written out, write it out as above so the column names stay snake_case only in SQL.

- [ ] **Step 4: Add the write route**

In `src/routes/stats.ts`, import:

```ts
import { getSession } from '../session.js';
import { getPlayer, saveProfileFields } from '../players.js';
```

and register:

```ts
  /** A player editing their own profile. The steamid comes from the session
   *  and never from the body: there is no "edit as" and no admin override
   *  here, so a body carrying someone else's id is simply ignored. */
  app.post('/api/profile', async (req, reply) => {
    const steamid = getSession(req);
    if (!steamid || !getPlayer(db, steamid)) {
      return reply.code(401).send({ error: 'not logged in' });
    }
    const result = saveProfileFields(db, steamid, req.body);
    if (!result.ok) return reply.code(400).send({ error: result.error });
    return { ok: true };
  });
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/profileApi.test.ts`
Expected: PASS.

- [ ] **Step 6: Extend the web client types**

In `web/src/api.ts`, extend the `Profile` interface:

```ts
export interface SocialLink {
  platform: string;
  label: string;
  handle: string;
  url: string;
}

export interface ProfileFieldsInput {
  bio?: string;
  pronouns?: string;
  country?: string;
  links?: Record<string, string>;
}
```

and in `Profile`, replace the `player` line with:

```ts
  player: {
    steamid: string;
    name: string;
    avatar: string | null;
    createdAt: string;
    bio: string | null;
    pronouns: string | null;
    country: string | null;
    twitchName: string | null;
  };
  social: SocialLink[];
```

Add to the `api` object, following whatever POST helper the file already uses (match the shape of `api.unlinkDiscord`):

```ts
  saveProfile: (body: ProfileFieldsInput) => post<{ ok: true }>('/api/profile', body),
```

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
npx vitest run tests/profileApi.test.ts tests/profileWrite.test.ts
git add src/playerQueries.ts src/routes/stats.ts web/src/api.ts tests/profileApi.test.ts
git commit -m "Serve and accept the profile fields over the API

The steamid on a profile write comes from the session and never from the body.
There is no edit-as and no admin override on this route, so a body carrying
somebody else's id is ignored rather than honoured, and a test pins that."
```

---

### Task 6: Profile display and the edit panel

**Files:**
- Create: `web/src/components/ProfileEdit.tsx`
- Create: `web/src/components/SocialChips.tsx`
- Modify: `web/src/routes/Profile.tsx`
- Modify: `web/src/components/PageHeader.tsx` (the `Headliner` is in `web/src/components/Headliner.tsx`; add the new props there)
- Modify: `web/src/styles/` (append to the sheet the other profile styles live in)
- Test: `tests/profileEdit.test.tsx` (create)

**Interfaces:**
- Consumes: `api.saveProfile`, `Profile['player']`, `Profile['social']`, `LINK_PLATFORMS` shape (mirrored in the web bundle as a small literal, since `src/` is server code and is not imported by `web/`).
- Produces: `<SocialChips links={...} />`, `<ProfileEdit fields={...} onSaved={...} />`.

Note: `web/` does not import from `src/`. The platform list is duplicated in `web/src/socialPlatforms.ts` as labels and placeholders only, with no patterns and no URL builders, because the server is the only thing that validates and the only thing that builds URLs. A test pins that the two key lists agree.

- [ ] **Step 1: Write the failing test**

Create `tests/profileEdit.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { PLATFORM_KEYS } from '../src/profileFields.js';
import { WEB_PLATFORMS } from '../web/src/socialPlatforms.js';

describe('web platform list', () => {
  it('agrees with the server on which platforms exist', () => {
    expect(WEB_PLATFORMS.map((p) => p.key)).toEqual([...PLATFORM_KEYS]);
  });

  it('carries no patterns and no url builders', () => {
    for (const p of WEB_PLATFORMS) {
      expect(Object.keys(p).sort()).toEqual(['key', 'label', 'placeholder']);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/profileEdit.test.tsx`
Expected: FAIL, cannot find module `../web/src/socialPlatforms.js`.

- [ ] **Step 3: Write the shared web list**

Create `web/src/socialPlatforms.ts`:

```ts
/** Labels and placeholders for the profile editor.
 *
 *  Deliberately carries no patterns and no URL builders. The server validates
 *  handles and the server builds every URL; duplicating either here would
 *  create a second answer to a question that must have exactly one. The keys
 *  are pinned against the server's list by a test. */
export const WEB_PLATFORMS = [
  { key: 'youtube', label: 'YouTube', placeholder: '@handle' },
  { key: 'x', label: 'X', placeholder: '@handle' },
  { key: 'bluesky', label: 'Bluesky', placeholder: 'name.bsky.social' },
  { key: 'tiktok', label: 'TikTok', placeholder: '@handle' },
] as const;
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/profileEdit.test.tsx`
Expected: PASS.

- [ ] **Step 5: Write the chips component**

Create `web/src/components/SocialChips.tsx`:

```tsx
import type { SocialLink } from '../api';

/** A player's off-site links. Every href here was built by the server from a
 *  template; nothing in this component constructs a URL. */
export function SocialChips({ links, twitchName }: { links: SocialLink[]; twitchName: string | null }) {
  if (!links.length && !twitchName) return null;
  return (
    <div class="socialchips">
      {twitchName && (
        <a
          class="socialchip socialchip--twitch"
          href={`https://www.twitch.tv/${encodeURIComponent(twitchName)}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          <span class="socialchip__label">Twitch</span>
          <span class="socialchip__handle">{twitchName}</span>
        </a>
      )}
      {links.map((l) => (
        <a key={l.platform} class="socialchip" href={l.url} target="_blank" rel="noopener noreferrer">
          <span class="socialchip__label">{l.label}</span>
          <span class="socialchip__handle">{l.handle}</span>
        </a>
      ))}
    </div>
  );
}
```

- [ ] **Step 6: Write the edit panel**

Create `web/src/components/ProfileEdit.tsx`:

```tsx
import { useState } from 'preact/hooks';
import { api, ApiError, type Profile } from '../api';
import { WEB_PLATFORMS } from '../socialPlatforms';
import { COUNTRY_OPTIONS } from '../countries';

/** Where a backend-only route must be reached by a full navigation, the same
 *  reason DiscordLinkCard does it. */
const BACKEND = { target: '_top', rel: 'noopener' } as const;

export function ProfileEdit(
  { data, twitchEnabled, onSaved }:
  { data: Profile; twitchEnabled: boolean; onSaved: () => void },
) {
  const [open, setOpen] = useState(false);
  const [bio, setBio] = useState(data.player.bio ?? '');
  const [pronouns, setPronouns] = useState(data.player.pronouns ?? '');
  const [country, setCountry] = useState(data.player.country ?? '');
  const [links, setLinks] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const p of WEB_PLATFORMS) {
      out[p.key] = data.social.find((s) => s.platform === p.key)?.handle ?? '';
    }
    return out;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.saveProfile({ bio, pronouns, country, links });
      setOpen(false);
      onSaved();
    } catch (err) {
      // The server's message names the field and says why, so show it rather
      // than a generic failure.
      setError(err instanceof ApiError ? (err.body?.error ?? 'Could not save.') : 'Could not save.');
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <div class="profileedit">
        <button class="btn btn--ghost" onClick={() => setOpen(true)}>Edit profile</button>
      </div>
    );
  }

  return (
    <div class="profileedit profileedit--open">
      <label class="field">
        <span class="field__label">Bio</span>
        <input
          class="field__input" type="text" maxLength={200} value={bio}
          placeholder="200 characters, no links"
          onInput={(e) => setBio((e.target as HTMLInputElement).value)}
        />
        <span class="field__hint">{bio.length}/200</span>
      </label>

      <label class="field">
        <span class="field__label">Pronouns</span>
        <input
          class="field__input" type="text" maxLength={24} value={pronouns}
          placeholder="they/them"
          onInput={(e) => setPronouns((e.target as HTMLInputElement).value)}
        />
      </label>

      <label class="field">
        <span class="field__label">Country</span>
        <select
          class="field__input" value={country}
          onChange={(e) => setCountry((e.target as HTMLSelectElement).value)}
        >
          <option value="">Not set</option>
          {COUNTRY_OPTIONS.map((c) => (
            <option key={c.code} value={c.code}>{c.flag} {c.name}</option>
          ))}
        </select>
      </label>

      {WEB_PLATFORMS.map((p) => (
        <label class="field" key={p.key}>
          <span class="field__label">{p.label}</span>
          <input
            class="field__input" type="text" value={links[p.key] ?? ''}
            placeholder={p.placeholder}
            onInput={(e) => setLinks({ ...links, [p.key]: (e.target as HTMLInputElement).value })}
          />
        </label>
      ))}

      {twitchEnabled && (
        <div class="field">
          <span class="field__label">Twitch</span>
          {data.player.twitchName ? (
            <span class="field__static">
              {data.player.twitchName}
              <button
                class="btn btn--ghost"
                onClick={async () => { await api.unlinkTwitch(); onSaved(); }}
              >Disconnect</button>
            </span>
          ) : (
            <a class="btn" href="/auth/twitch" {...BACKEND}>Connect Twitch</a>
          )}
        </div>
      )}

      {error && <p class="field__error">{error}</p>}

      <div class="profileedit__actions">
        <button class="btn" onClick={save} disabled={busy}>Save</button>
        <button class="btn btn--ghost" onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 7: Write the web country list**

Create `web/src/countries.ts`:

```ts
/** The picker's options. Mirrors src/countries.ts, which is server code and is
 *  not importable from the bundle; the server validates against its own copy,
 *  so a drift here can only ever make an option the server then refuses. */
const CODES =
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS '
  + 'BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE '
  + 'EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM '
  + 'HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC '
  + 'LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA '
  + 'NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW '
  + 'SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO '
  + 'TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW';

let display: Intl.DisplayNames | null = null;
try {
  display = new Intl.DisplayNames(['en'], { type: 'region' });
} catch {
  display = null;
}

export function countryFlag(code: string): string {
  const up = code.toUpperCase();
  if (!/^[A-Z]{2}$/.test(up)) return '';
  const base = 0x1f1e6 - 'A'.charCodeAt(0);
  return String.fromCodePoint(base + up.charCodeAt(0), base + up.charCodeAt(1));
}

export function countryName(code: string): string {
  const up = code.toUpperCase();
  try {
    return display?.of(up) ?? up;
  } catch {
    return up;
  }
}

export const COUNTRY_OPTIONS = CODES.split(' ')
  .map((code) => ({ code, name: countryName(code), flag: countryFlag(code) }))
  .sort((a, b) => a.name.localeCompare(b.name));
```

- [ ] **Step 8: Wire it into the profile page**

In `web/src/routes/Profile.tsx`, add the imports:

```tsx
import { ProfileEdit } from '../components/ProfileEdit';
import { SocialChips } from '../components/SocialChips';
import { countryFlag, countryName } from '../countries';
```

Extend the `Headliner` call with the new identity bits, and put the chips and the editor directly below it. Replace the existing `<Headliner .../>` element and the Discord panel that follows with:

```tsx
        <Headliner
          eyebrow={`Joined ${fmtDate(player.createdAt)}`}
          name={player.name}
          avatar={player.avatar}
          pronouns={player.pronouns}
          countryCode={player.country}
          countryLabel={player.country ? countryName(player.country) : null}
          countryFlag={player.country ? countryFlag(player.country) : null}
          bio={player.bio}
          rating={rating ? rating.sr : null}
          delta={lastDelta}
          stats={rating ? [
            { label: 'Record', value: `${rating.wins}W ${rating.losses}L` },
            { label: 'Peak', value: peak ?? 'n/a' },
            { label: 'Matches', value: totals.games },
          ] : []}
        />

        <SocialChips links={data.social} twitchName={player.twitchName} />

        {session && (session.kind === 'active' || session.kind === 'pending') && session.me.steamid === steamid && (
          <Panel>
            <DiscordLinkCard me={session.me} onChange={refresh} />
            <ProfileEdit
              data={data}
              twitchEnabled={session.me.twitchEnabled ?? false}
              onSaved={() => refresh?.()}
            />
          </Panel>
        )}
```

- [ ] **Step 9: Extend `Headliner`**

In `web/src/components/Headliner.tsx`, add the optional props and render them. Add to the props type:

```tsx
  pronouns?: string | null;
  countryCode?: string | null;
  countryLabel?: string | null;
  countryFlag?: string | null;
  bio?: string | null;
```

and render, immediately after the element holding the name:

```tsx
      {(countryFlag || pronouns) && (
        <div class="headliner__identity">
          {countryFlag && (
            <span class="headliner__flag" title={countryLabel ?? countryCode ?? ''} aria-label={countryLabel ?? ''}>
              {countryFlag}
            </span>
          )}
          {pronouns && <span class="headliner__pronouns">{pronouns}</span>}
        </div>
      )}
      {bio && <p class="headliner__bio">{bio}</p>}
```

- [ ] **Step 10: Add the styles**

Append to the stylesheet that already holds the profile styles (find it with `grep -rl 'headliner' web/src/styles`):

```css
.headliner__identity { display: flex; gap: .5rem; align-items: center; font-size: .9rem; opacity: .8; }
.headliner__flag { font-size: 1.1rem; line-height: 1; }
.headliner__bio { margin: .4rem 0 0; max-width: 48ch; opacity: .85; }

.socialchips { display: flex; flex-wrap: wrap; gap: .5rem; margin: .25rem 0 .5rem; }
.socialchip {
  display: inline-flex; gap: .4rem; align-items: baseline;
  padding: .25rem .6rem; border-radius: 999px;
  border: 1px solid var(--line, #333); text-decoration: none; font-size: .85rem;
}
.socialchip:hover { border-color: var(--accent, #888); }
.socialchip__label { opacity: .6; }
.socialchip--twitch .socialchip__label { color: #a970ff; opacity: 1; }

.profileedit { margin-top: .75rem; }
.profileedit--open { display: grid; gap: .6rem; }
.field { display: grid; gap: .2rem; }
.field__label { font-size: .8rem; opacity: .7; }
.field__hint { font-size: .75rem; opacity: .5; justify-self: end; }
.field__error { color: var(--bad, #e66); font-size: .85rem; margin: 0; }
.field__static { display: flex; gap: .6rem; align-items: center; }
.profileedit__actions { display: flex; gap: .5rem; margin-top: .25rem; }
```

- [ ] **Step 11: Typecheck, test, commit**

```bash
npm run typecheck
npx vitest run
git add web/src src/profileFields.ts tests/profileEdit.test.tsx
git commit -m "Show and edit the profile fields

The web bundle keeps its own platform and country lists because web/ does not
import from src/, but it deliberately keeps only labels and placeholders. It
has no handle patterns and no URL builders: the server is the only thing that
validates and the only thing that builds a URL, and a second answer to either
question is how the two drift into disagreeing. A test pins the two key lists
together.

The editor is a panel on your own profile rather than a /settings route. Six
fields do not earn a page, and moving them later is small."
```

---

### Task 7: Twitch config and API client

**Files:**
- Modify: `src/config.ts`
- Create: `src/twitch/api.ts`
- Create: `tests/fakes/fakeTwitchApi.ts`
- Test: `tests/twitchApi.test.ts` (create), `tests/config.test.ts` (extend)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `Config['twitch']: TwitchConfig | null` where `TwitchConfig = { clientId: string; clientSecret: string }`
  - `interface TwitchStream { userId: string; userLogin: string; title: string; gameName: string; viewers: number; thumbnailUrl: string; startedAt: string }`
  - `interface TwitchApi { exchangeCode(code: string, redirectUri: string): Promise<{ accessToken: string }>; getCurrentUser(accessToken: string): Promise<{ id: string; login: string }>; getStreams(userIds: string[]): Promise<TwitchStream[]> }`
  - `makeTwitchApi(cfg: TwitchConfig, fetchImpl?: typeof fetch): TwitchApi`
  - `fakeTwitchApi(opts): TwitchApi` in the fakes directory.

- [ ] **Step 1: Write the failing test**

Create `tests/twitchApi.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { makeTwitchApi } from '../src/twitch/api.js';
import { loadConfig } from '../src/config.js';

const CFG = { clientId: 'cid', clientSecret: 'secret' };

function fetchStub(handler: (url: string, init?: RequestInit) => { status?: number; body: unknown }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const { status = 200, body } = handler(url, init);
    return new Response(JSON.stringify(body), {
      status, headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('config', () => {
  it('is null when either twitch variable is missing', () => {
    expect(loadConfig({}).twitch).toBe(null);
    expect(loadConfig({ TWITCH_CLIENT_ID: 'a' }).twitch).toBe(null);
    expect(loadConfig({ TWITCH_CLIENT_SECRET: 'b' }).twitch).toBe(null);
  });

  it('loads when both are present', () => {
    expect(loadConfig({ TWITCH_CLIENT_ID: 'a', TWITCH_CLIENT_SECRET: 'b' }).twitch)
      .toEqual({ clientId: 'a', clientSecret: 'b' });
  });
});

describe('getStreams', () => {
  it('fetches an app token once and reuses it', async () => {
    const { impl, calls } = fetchStub((url) =>
      url.includes('oauth2/token')
        ? { body: { access_token: 'app1', expires_in: 3600 } }
        : { body: { data: [] } });
    const api = makeTwitchApi(CFG, impl);
    await api.getStreams(['1']);
    await api.getStreams(['1']);
    expect(calls.filter((c) => c.url.includes('oauth2/token')).length).toBe(1);
  });

  it('sends every user id and the client id header', async () => {
    const { impl, calls } = fetchStub((url) =>
      url.includes('oauth2/token')
        ? { body: { access_token: 'app1', expires_in: 3600 } }
        : { body: { data: [] } });
    const api = makeTwitchApi(CFG, impl);
    await api.getStreams(['11', '22']);
    const streams = calls.find((c) => c.url.includes('helix/streams'))!;
    expect(streams.url).toContain('user_id=11');
    expect(streams.url).toContain('user_id=22');
    const headers = streams.init!.headers as Record<string, string>;
    expect(headers['Client-Id']).toBe('cid');
    expect(headers.Authorization).toBe('Bearer app1');
  });

  it('chunks past 100 ids into separate requests', async () => {
    const { impl, calls } = fetchStub((url) =>
      url.includes('oauth2/token')
        ? { body: { access_token: 'app1', expires_in: 3600 } }
        : { body: { data: [] } });
    const api = makeTwitchApi(CFG, impl);
    await api.getStreams(Array.from({ length: 150 }, (_, i) => String(i)));
    expect(calls.filter((c) => c.url.includes('helix/streams')).length).toBe(2);
  });

  it('re-fetches the app token once on a 401 and retries', async () => {
    let streamCalls = 0;
    const { impl, calls } = fetchStub((url) => {
      if (url.includes('oauth2/token')) return { body: { access_token: `app${calls.length}`, expires_in: 3600 } };
      streamCalls += 1;
      if (streamCalls === 1) return { status: 401, body: { message: 'invalid' } };
      return { body: { data: [{
        user_id: '11', user_login: 'alice', title: 'pugs', game_name: 'Left 4 Dead',
        viewer_count: 18, thumbnail_url: 'https://t/{width}x{height}.jpg',
        started_at: '2026-09-20T00:00:00Z',
      }] } };
    });
    const api = makeTwitchApi(CFG, impl);
    const out = await api.getStreams(['11']);
    expect(out).toEqual([{
      userId: '11', userLogin: 'alice', title: 'pugs', gameName: 'Left 4 Dead',
      viewers: 18, thumbnailUrl: 'https://t/{width}x{height}.jpg',
      startedAt: '2026-09-20T00:00:00Z',
    }]);
    expect(calls.filter((c) => c.url.includes('oauth2/token')).length).toBe(2);
  });

  it('gives up rather than looping on a second 401', async () => {
    const { impl } = fetchStub((url) =>
      url.includes('oauth2/token')
        ? { body: { access_token: 'app1', expires_in: 3600 } }
        : { status: 401, body: { message: 'invalid' } });
    const api = makeTwitchApi(CFG, impl);
    await expect(api.getStreams(['11'])).rejects.toThrow(/401/);
  });

  it('asks for nothing when there is nobody to ask about', async () => {
    const { impl, calls } = fetchStub(() => ({ body: { data: [] } }));
    const api = makeTwitchApi(CFG, impl);
    expect(await api.getStreams([])).toEqual([]);
    expect(calls.length).toBe(0);
  });
});

describe('oauth', () => {
  it('exchanges a code and reads the user', async () => {
    const { impl } = fetchStub((url) =>
      url.includes('oauth2/token')
        ? { body: { access_token: 'user1' } }
        : { body: { data: [{ id: '11', login: 'alice', display_name: 'Alice' }] } });
    const api = makeTwitchApi(CFG, impl);
    const { accessToken } = await api.exchangeCode('code', 'https://pug.test/cb');
    expect(accessToken).toBe('user1');
    expect(await api.getCurrentUser(accessToken)).toEqual({ id: '11', login: 'alice' });
  });

  it('throws when the user response is empty', async () => {
    const { impl } = fetchStub((url) =>
      url.includes('oauth2/token') ? { body: { access_token: 'user1' } } : { body: { data: [] } });
    const api = makeTwitchApi(CFG, impl);
    await expect(api.getCurrentUser('user1')).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/twitchApi.test.ts`
Expected: FAIL, cannot find module `../src/twitch/api.js`.

- [ ] **Step 3: Add the config block**

In `src/config.ts`, add the interface next to `DiscordConfig`:

```ts
/** Twitch application. Null when either piece is missing, which is the tested
 *  default: the site then behaves exactly as it did before Twitch existed. No
 *  scopes are ever requested, so the only permission involved is knowing which
 *  account authorised. */
export interface TwitchConfig {
  clientId: string;
  clientSecret: string;
}
```

Add `twitch: TwitchConfig | null;` to `Config`, add `twitch: loadTwitch(env),` to `loadConfig`, and:

```ts
function loadTwitch(env: Record<string, string | undefined>): TwitchConfig | null {
  const clientId = env.TWITCH_CLIENT_ID?.trim();
  const clientSecret = env.TWITCH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}
```

- [ ] **Step 4: Write the API client**

Create `src/twitch/api.ts`:

```ts
import type { TwitchConfig } from '../config.js';

export interface TwitchStream {
  userId: string;
  userLogin: string;
  title: string;
  gameName: string;
  viewers: number;
  /** Twitch's template, with {width} and {height} still in it. Substituted at
   *  render, not here, so one stored value can serve any size. */
  thumbnailUrl: string;
  startedAt: string;
}

export interface TwitchApi {
  exchangeCode(code: string, redirectUri: string): Promise<{ accessToken: string }>;
  getCurrentUser(accessToken: string): Promise<{ id: string; login: string }>;
  getStreams(userIds: string[]): Promise<TwitchStream[]>;
}

const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const HELIX = 'https://api.twitch.tv/helix';
/** Helix accepts at most 100 user_id parameters per request. */
const CHUNK = 100;

export function makeTwitchApi(cfg: TwitchConfig, fetchImpl: typeof fetch = fetch): TwitchApi {
  // The app token, cached in memory. Nothing persists it: it is cheap to
  // re-fetch and a restart is not a reason to keep a credential on disk.
  let appToken: string | null = null;
  let appTokenExpiry = 0;

  async function appAccessToken(force = false): Promise<string> {
    if (!force && appToken && Date.now() < appTokenExpiry) return appToken;
    const body = new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      grant_type: 'client_credentials',
    });
    const res = await fetchImpl(TOKEN_URL, { method: 'POST', body });
    if (!res.ok) throw new Error(`twitch app token failed: ${res.status}`);
    const json = await res.json() as { access_token: string; expires_in?: number };
    appToken = json.access_token;
    // A minute of slack, so a token never expires mid-request.
    appTokenExpiry = Date.now() + Math.max(0, (json.expires_in ?? 3600) - 60) * 1000;
    return appToken;
  }

  async function helix(path: string, token: string): Promise<Response> {
    return fetchImpl(`${HELIX}${path}`, {
      headers: { 'Client-Id': cfg.clientId, Authorization: `Bearer ${token}` },
    });
  }

  return {
    async exchangeCode(code, redirectUri) {
      const body = new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      });
      const res = await fetchImpl(TOKEN_URL, { method: 'POST', body });
      if (!res.ok) throw new Error(`twitch code exchange failed: ${res.status}`);
      const json = await res.json() as { access_token: string };
      return { accessToken: json.access_token };
    },

    async getCurrentUser(accessToken) {
      const res = await helix('/users', accessToken);
      if (!res.ok) throw new Error(`twitch users failed: ${res.status}`);
      const json = await res.json() as { data: { id: string; login: string }[] };
      const user = json.data?.[0];
      if (!user) throw new Error('twitch users returned nobody');
      return { id: user.id, login: user.login };
    },

    async getStreams(userIds) {
      if (userIds.length === 0) return [];
      const out: TwitchStream[] = [];
      for (let i = 0; i < userIds.length; i += CHUNK) {
        const params = new URLSearchParams();
        for (const id of userIds.slice(i, i + CHUNK)) params.append('user_id', id);
        let token = await appAccessToken();
        let res = await helix(`/streams?${params}`, token);
        if (res.status === 401) {
          // The cached token was rejected. Re-fetch once and retry; a second
          // 401 is a real failure and must not become a loop.
          token = await appAccessToken(true);
          res = await helix(`/streams?${params}`, token);
        }
        if (!res.ok) throw new Error(`twitch streams failed: ${res.status}`);
        const json = await res.json() as {
          data: {
            user_id: string; user_login: string; title: string; game_name: string;
            viewer_count: number; thumbnail_url: string; started_at: string;
          }[];
        };
        for (const s of json.data ?? []) {
          out.push({
            userId: s.user_id,
            userLogin: s.user_login,
            title: s.title ?? '',
            gameName: s.game_name ?? '',
            viewers: s.viewer_count ?? 0,
            thumbnailUrl: s.thumbnail_url ?? '',
            startedAt: s.started_at ?? '',
          });
        }
      }
      return out;
    },
  };
}
```

- [ ] **Step 5: Write the fake**

Create `tests/fakes/fakeTwitchApi.ts`:

```ts
import type { TwitchApi, TwitchStream } from '../../src/twitch/api.js';

export interface FakeTwitchOpts {
  /** OAuth: code -> the user it resolves to. */
  users?: Record<string, { id: string; login: string }>;
  /** Who is live right now, keyed by twitch user id. */
  live?: Record<string, Partial<TwitchStream>>;
  /** When set, getStreams throws with this message. */
  failStreams?: string;
}

export function fakeTwitchApi(opts: FakeTwitchOpts = {}): TwitchApi & { calls: number } {
  const state = { calls: 0 };
  const api: TwitchApi = {
    async exchangeCode(code) {
      if (!opts.users?.[code]) throw new Error('bad code');
      return { accessToken: `token:${code}` };
    },
    async getCurrentUser(accessToken) {
      const code = accessToken.replace(/^token:/, '');
      const user = opts.users?.[code];
      if (!user) throw new Error('bad token');
      return user;
    },
    async getStreams(userIds) {
      state.calls += 1;
      if (opts.failStreams) throw new Error(opts.failStreams);
      return userIds
        .filter((id) => opts.live?.[id])
        .map((id) => ({
          userId: id,
          userLogin: `login${id}`,
          title: 'streaming',
          gameName: 'Left 4 Dead',
          viewers: 10,
          thumbnailUrl: 'https://t/{width}x{height}.jpg',
          startedAt: '2026-09-20T00:00:00Z',
          ...opts.live![id],
        }));
    },
  };
  return Object.assign(api, {
    get calls() { return state.calls; },
  }) as TwitchApi & { calls: number };
}
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/twitchApi.test.ts tests/config.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add src/config.ts src/twitch tests/twitchApi.test.ts tests/fakes/fakeTwitchApi.ts
git commit -m "Add the Twitch config block and API client

One request covers up to 100 channels, so the whole community is a single
HTTP call per poll however many people link. That is what makes a 60 second
interval free rather than something to budget.

The app token is cached in memory and never persisted: it is cheap to
re-fetch, and a restart is not a reason to keep a credential on disk. A 401
re-fetches it once and retries; a second 401 throws, because the alternative
is a loop against Twitch."
```

---

### Task 8: The Twitch OAuth route

**Files:**
- Create: `src/routes/twitchAuth.ts`
- Modify: `src/server.ts` (build the api, register the routes, extend the deps type)
- Modify: `src/routes/api.ts` (add `twitchEnabled` and `twitch` to `/api/me`)
- Modify: `web/src/api.ts` (`Me` gains `twitchEnabled` and `twitch`)
- Test: `tests/twitchAuth.test.ts` (create)

**Interfaces:**
- Consumes: `makeTwitchApi`, `TwitchApi` from `src/twitch/api.ts`; `linkTwitch`, `unlinkTwitch` from `src/players.ts`.
- Produces: `twitchAuthRoutes(app, { config, db, api })`; routes `GET /auth/twitch`, `GET /auth/twitch/callback`, `POST /api/twitch/unlink`; `buildServer` dep `twitchApi?: TwitchApi | null`.

- [ ] **Step 1: Write the failing test**

Create `tests/twitchAuth.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { upsertPlayer } from '../src/players.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import { fakeTwitchApi } from './fakes/fakeTwitchApi.js';

const P1 = '76561198000000001';
const P2 = '76561198000000002';
const ENV = {
  PUBLIC_URL: 'https://pug.test',
  TWITCH_CLIENT_ID: 'cid',
  TWITCH_CLIENT_SECRET: 'secret',
};

let db: DB;
let app: FastifyInstance;

async function build(env: Record<string, string>, api = fakeTwitchApi({
  users: { good: { id: '999', login: 'alicetv' } },
})) {
  db = openDb(':memory:');
  app = await buildServer({
    config: loadConfig(env), db, orchestrator: stubOrchestrator(),
    verifyLogin: async () => P1,
    fetchPersona: async () => ({ name: 'alice', avatar: null }),
    twitchApi: api,
    serverExec: async () => {},
  });
  upsertPlayer(db, P1, 'alice', null);
  upsertPlayer(db, P2, 'bob', null);
}

afterEach(async () => { await app.close(); });

/** The state the callback expects, obtained the only legitimate way: by
 *  starting the flow and reading it off the redirect. */
async function startFlow(cookies: Record<string, string>): Promise<string> {
  const res = await app.inject({ method: 'GET', url: '/auth/twitch', cookies });
  const url = new URL(res.headers.location as string);
  return url.searchParams.get('state')!;
}

describe('unconfigured', () => {
  it('every twitch route 404s', async () => {
    await build({});
    const cookies = authedCookie(app, db, P1);
    expect((await app.inject({ method: 'GET', url: '/auth/twitch', cookies })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/auth/twitch/callback?code=x&state=y', cookies })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/twitch/unlink', cookies })).statusCode).toBe(404);
  });

  it('/api/me reports twitch disabled', async () => {
    await build({});
    const cookies = authedCookie(app, db, P1);
    const me = (await app.inject({ method: 'GET', url: '/api/me', cookies })).json();
    expect(me.twitchEnabled).toBe(false);
  });
});

describe('configured', () => {
  it('needs a session to start', async () => {
    await build(ENV);
    expect((await app.inject({ method: 'GET', url: '/auth/twitch' })).statusCode).toBe(401);
  });

  it('redirects to twitch with no scope requested', async () => {
    await build(ENV);
    const cookies = authedCookie(app, db, P1);
    const res = await app.inject({ method: 'GET', url: '/auth/twitch', cookies });
    expect(res.statusCode).toBe(302);
    const url = new URL(res.headers.location as string);
    expect(url.origin + url.pathname).toBe('https://id.twitch.tv/oauth2/authorize');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('redirect_uri')).toBe('https://pug.test/auth/twitch/callback');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('');
    expect(url.searchParams.get('state')).toBeTruthy();
  });

  it('links on a good callback', async () => {
    await build(ENV);
    const cookies = authedCookie(app, db, P1);
    const state = await startFlow(cookies);
    const res = await app.inject({
      method: 'GET', url: `/auth/twitch/callback?code=good&state=${state}`, cookies,
    });
    expect(res.headers.location).toBe(`/player/${P1}?twitch=linked`);
    expect(db.prepare('SELECT twitch_id, twitch_name FROM players WHERE steamid = ?').get(P1))
      .toEqual({ twitch_id: '999', twitch_name: 'alicetv' });
  });

  it('refuses a state that was not issued to this session', async () => {
    await build(ENV);
    const cookies = authedCookie(app, db, P1);
    const res = await app.inject({
      method: 'GET', url: '/auth/twitch/callback?code=good&state=deadbeef:1',
      cookies,
    });
    expect(res.statusCode).toBe(400);
    expect(db.prepare('SELECT twitch_id FROM players WHERE steamid = ?').get(P1))
      .toEqual({ twitch_id: null });
  });

  it('refuses another session state, so a link cannot be walked onto a victim', async () => {
    await build(ENV);
    const stateForP1 = await startFlow(authedCookie(app, db, P1));
    const cookiesP2 = authedCookie(app, db, P2);
    const res = await app.inject({
      method: 'GET', url: `/auth/twitch/callback?code=good&state=${stateForP1}`, cookies: cookiesP2,
    });
    expect(res.statusCode).toBe(400);
  });

  it('reports a channel another player already holds', async () => {
    await build(ENV);
    db.prepare("UPDATE players SET twitch_id = '999', twitch_name = 'alicetv' WHERE steamid = ?").run(P2);
    const cookies = authedCookie(app, db, P1);
    const state = await startFlow(cookies);
    const res = await app.inject({
      method: 'GET', url: `/auth/twitch/callback?code=good&state=${state}`, cookies,
    });
    expect(res.headers.location).toBe(`/player/${P1}?twitch=taken`);
  });

  it('reports a failed exchange rather than throwing', async () => {
    await build(ENV);
    const cookies = authedCookie(app, db, P1);
    const state = await startFlow(cookies);
    const res = await app.inject({
      method: 'GET', url: `/auth/twitch/callback?code=nope&state=${state}`, cookies,
    });
    expect(res.headers.location).toBe(`/player/${P1}?twitch=failed`);
  });

  it('unlinks', async () => {
    await build(ENV);
    const cookies = authedCookie(app, db, P1);
    const state = await startFlow(cookies);
    await app.inject({ method: 'GET', url: `/auth/twitch/callback?code=good&state=${state}`, cookies });
    const res = await app.inject({ method: 'POST', url: '/api/twitch/unlink', cookies });
    expect(res.statusCode).toBe(200);
    expect(db.prepare('SELECT twitch_id FROM players WHERE steamid = ?').get(P1))
      .toEqual({ twitch_id: null });
  });

  it('/api/me carries the linked channel', async () => {
    await build(ENV);
    const cookies = authedCookie(app, db, P1);
    const state = await startFlow(cookies);
    await app.inject({ method: 'GET', url: `/auth/twitch/callback?code=good&state=${state}`, cookies });
    const me = (await app.inject({ method: 'GET', url: '/api/me', cookies })).json();
    expect(me.twitchEnabled).toBe(true);
    expect(me.twitch).toEqual({ id: '999', name: 'alicetv' });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/twitchAuth.test.ts`
Expected: FAIL, 404 on `/auth/twitch` even when configured.

- [ ] **Step 3: Write the route**

Create `src/routes/twitchAuth.ts`:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { DB } from '../db.js';
import type { TwitchApi } from '../twitch/api.js';
import { getSession } from '../session.js';
import { getPlayer, linkTwitch, unlinkTwitch } from '../players.js';

export interface TwitchAuthOpts { config: Config; db: DB; api: TwitchApi | null }

const STATE_TTL_MS = 10 * 60 * 1000;

/** OAuth state bound to the session's steamid, exactly as discordAuth does it.
 *  Without the binding, anyone could walk a logged-in player through a
 *  callback that attaches the attacker's Twitch channel to the victim's row. */
function signState(secret: string, steamid: string, ts: number): string {
  const mac = createHmac('sha256', secret).update(`twitch:${steamid}:${ts}`).digest('hex');
  return `${mac}:${ts}`;
}

function verifyState(secret: string, steamid: string, state: string, now = Date.now()): boolean {
  const [mac, tsRaw] = state.split(':');
  const ts = Number(tsRaw);
  if (!mac || !Number.isFinite(ts) || now - ts > STATE_TTL_MS || ts > now + 60_000) return false;
  const want = Buffer.from(signState(secret, steamid, ts).split(':')[0], 'hex');
  let got: Buffer;
  try {
    got = Buffer.from(mac, 'hex');
  } catch {
    return false;
  }
  return got.length === want.length && timingSafeEqual(got, want);
}

export async function twitchAuthRoutes(app: FastifyInstance, opts: TwitchAuthOpts): Promise<void> {
  const { config, db, api } = opts;
  const twitch = config.twitch;
  const redirectUri = `${config.publicUrl}/auth/twitch/callback`;

  /** 404 when Twitch is unconfigured, 401 without a session; else the steamid. */
  const guard = (req: FastifyRequest, reply: FastifyReply): string | null => {
    if (!twitch || !api) {
      reply.code(404).send({ error: 'not found' });
      return null;
    }
    const steamid = getSession(req);
    if (!steamid || !getPlayer(db, steamid)) {
      reply.code(401).send({ error: 'not logged in' });
      return null;
    }
    return steamid;
  };

  app.get('/auth/twitch', async (req, reply) => {
    const steamid = guard(req, reply);
    if (!steamid) return reply;
    const params = new URLSearchParams({
      client_id: twitch!.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      // Empty on purpose. Knowing which account authorised needs no scope, and
      // asking for one we do not use is a permission prompt we have to justify.
      scope: '',
      state: signState(config.cookieSecret, steamid, Date.now()),
    });
    return reply.redirect(`https://id.twitch.tv/oauth2/authorize?${params}`);
  });

  app.get('/auth/twitch/callback', async (req, reply) => {
    const steamid = guard(req, reply);
    if (!steamid) return reply;
    const { code, state } = req.query as { code?: string; state?: string };
    if (!code || !state || !verifyState(config.cookieSecret, steamid, state)) {
      return reply.code(400).send('Twitch link failed: invalid state. Start again from your profile.');
    }
    const back = (result: string) => reply.redirect(`/player/${steamid}?twitch=${result}`);
    let user: { id: string; login: string };
    try {
      const { accessToken } = await api!.exchangeCode(code, redirectUri);
      user = await api!.getCurrentUser(accessToken);
    } catch (err) {
      console.error('[twitch] oauth callback failed:', err);
      return back('failed');
    }
    const linked = linkTwitch(db, steamid, user.id, user.login);
    if (!linked.ok) return back('taken');
    return back('linked');
  });

  app.post('/api/twitch/unlink', async (req, reply) => {
    const steamid = guard(req, reply);
    if (!steamid) return reply;
    unlinkTwitch(db, steamid);
    return { ok: true };
  });
}
```

- [ ] **Step 4: Register it in `server.ts`**

Add the import beside the Discord one:

```ts
import { twitchAuthRoutes } from './routes/twitchAuth.js';
import { makeTwitchApi, type TwitchApi } from './twitch/api.js';
```

Add `twitchApi?: TwitchApi | null;` to the `buildServer` deps interface, then beside the `discordAuthRoutes` registration:

```ts
  // Injectable for tests, built from config otherwise. Null when unconfigured,
  // which makes every twitch route 404 rather than half-work.
  const twitchApi: TwitchApi | null = deps.twitchApi !== undefined
    ? deps.twitchApi
    : (deps.config.twitch ? makeTwitchApi(deps.config.twitch) : null);
  await app.register(twitchAuthRoutes, { config: deps.config, db: deps.db, api: twitchApi });
```

- [ ] **Step 5: Extend `/api/me`**

In `src/routes/api.ts`, in the `/api/me` handler, add to the returned object:

```ts
    twitchEnabled: Boolean(config.twitch),
    twitch: row.twitch_id ? { id: row.twitch_id, name: row.twitch_name } : null,
```

`apiRoutes` currently receives `{ db, matchmaker }`; add `config` to its options and pass `config: deps.config` at the registration site in `server.ts`. Make sure the query behind `/api/me` selects `twitch_id, twitch_name` (extend the existing `SELECT` rather than adding a second query).

- [ ] **Step 6: Extend the web `Me` type**

In `web/src/api.ts`, in `Me`:

```ts
  /** False when the server has no Twitch app configured: hide every Twitch control. */
  twitchEnabled?: boolean;
  twitch?: { id: string; name: string } | null;
```

and add the client call next to `unlinkDiscord`:

```ts
  unlinkTwitch: () => post<{ ok: true }>('/api/twitch/unlink', {}),
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run tests/twitchAuth.test.ts`
Expected: PASS.

- [ ] **Step 8: Typecheck, full test, commit**

```bash
npm run typecheck
npx vitest run
git add src/routes/twitchAuth.ts src/server.ts src/routes/api.ts web/src/api.ts tests/twitchAuth.test.ts
git commit -m "Link Twitch over OAuth, the same shape as Discord

The state is an HMAC bound to the session's steamid, for the reason
discordAuth.ts already records: without the binding, an attacker can walk a
logged-in player through a callback that attaches the attacker's channel to
the victim's row. A test pins that a state issued to one session is refused by
another.

No scope is requested. Knowing which account authorised needs none, and asking
for one we never use is a permission prompt we would have to justify."
```

---

### Task 9: The Twitch poller

**Files:**
- Create: `src/twitchPoll.ts`
- Modify: `src/server.ts` (start the interval, tear it down on close)
- Test: `tests/twitchPoll.test.ts` (create)

**Interfaces:**
- Consumes: `TwitchApi` from `src/twitch/api.ts`.
- Produces:
  - `TWITCH_POLL_MS = 60_000`, `TWITCH_STALE_MS = 600_000`
  - `pollTwitch(db: DB, api: TwitchApi, now?: Date): Promise<void>`
  - `twitchCacheStale(db: DB, now?: Date): boolean`
  - `startTwitchPoll(db: DB, api: TwitchApi): () => void` returning a stop function

- [ ] **Step 1: Write the failing test**

Create `tests/twitchPoll.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer } from '../src/players.js';
import { pollTwitch, twitchCacheStale, TWITCH_STALE_MS } from '../src/twitchPoll.js';
import { fakeTwitchApi } from './fakes/fakeTwitchApi.js';

const P1 = '76561198000000001';
const P2 = '76561198000000002';
const T0 = new Date('2026-09-20T12:00:00.000Z');
let db: DB;

function link(steamid: string, twitchId: string, login: string) {
  db.prepare('UPDATE players SET twitch_id = ?, twitch_name = ? WHERE steamid = ?')
    .run(twitchId, login, steamid);
}

beforeEach(() => {
  db = openDb(':memory:');
  upsertPlayer(db, P1, 'alice', null);
  upsertPlayer(db, P2, 'bob', null);
});

describe('pollTwitch', () => {
  it('asks about nobody when nobody has linked', async () => {
    const api = fakeTwitchApi({});
    await pollTwitch(db, api, T0);
    expect(api.calls).toBe(0);
  });

  it('records a live streamer', async () => {
    link(P1, '11', 'alicetv');
    const api = fakeTwitchApi({ live: { 11: { viewers: 18, title: 'pugs' } } });
    await pollTwitch(db, api, T0);
    const row = db.prepare('SELECT * FROM twitch_status WHERE player_id = ?').get(P1) as any;
    expect(row.is_live).toBe(1);
    expect(row.viewers).toBe(18);
    expect(row.title).toBe('pugs');
    expect(row.last_live_at).toBe(T0.toISOString());
    expect(row.checked_at).toBe(T0.toISOString());
  });

  it('records an offline streamer without inventing a last_live_at', async () => {
    link(P1, '11', 'alicetv');
    await pollTwitch(db, fakeTwitchApi({}), T0);
    const row = db.prepare('SELECT * FROM twitch_status WHERE player_id = ?').get(P1) as any;
    expect(row.is_live).toBe(0);
    expect(row.last_live_at).toBe(null);
  });

  it('keeps last_live_at when someone goes offline', async () => {
    link(P1, '11', 'alicetv');
    await pollTwitch(db, fakeTwitchApi({ live: { 11: {} } }), T0);
    const later = new Date(T0.getTime() + 60_000);
    await pollTwitch(db, fakeTwitchApi({}), later);
    const row = db.prepare('SELECT * FROM twitch_status WHERE player_id = ?').get(P1) as any;
    expect(row.is_live).toBe(0);
    expect(row.last_live_at).toBe(T0.toISOString());
    expect(row.checked_at).toBe(later.toISOString());
  });

  it('refreshes a changed twitch login', async () => {
    link(P1, '11', 'oldname');
    await pollTwitch(db, fakeTwitchApi({ live: { 11: { userLogin: 'newname' } } }), T0);
    expect(db.prepare('SELECT twitch_name FROM players WHERE steamid = ?').get(P1))
      .toEqual({ twitch_name: 'newname' });
  });

  it('leaves the cache untouched when the API throws', async () => {
    link(P1, '11', 'alicetv');
    await pollTwitch(db, fakeTwitchApi({ live: { 11: {} } }), T0);
    const later = new Date(T0.getTime() + 60_000);
    await pollTwitch(db, fakeTwitchApi({ failStreams: 'twitch down' }), later);
    const row = db.prepare('SELECT * FROM twitch_status WHERE player_id = ?').get(P1) as any;
    expect(row.is_live).toBe(1);
    expect(row.checked_at).toBe(T0.toISOString());
  });

  it('drops a status row once the player unlinks', async () => {
    link(P1, '11', 'alicetv');
    await pollTwitch(db, fakeTwitchApi({ live: { 11: {} } }), T0);
    db.prepare('UPDATE players SET twitch_id = NULL, twitch_name = NULL WHERE steamid = ?').run(P1);
    await pollTwitch(db, fakeTwitchApi({}), new Date(T0.getTime() + 60_000));
    expect(db.prepare('SELECT COUNT(*) AS n FROM twitch_status').get()).toEqual({ n: 0 });
  });

  it('handles two linked players at once', async () => {
    link(P1, '11', 'alicetv');
    link(P2, '22', 'bobtv');
    await pollTwitch(db, fakeTwitchApi({ live: { 11: {} } }), T0);
    const live = db.prepare('SELECT player_id FROM twitch_status WHERE is_live = 1').all();
    expect(live).toEqual([{ player_id: P1 }]);
  });
});

describe('twitchCacheStale', () => {
  it('is stale with no rows at all', () => {
    expect(twitchCacheStale(db, T0)).toBe(true);
  });

  it('is fresh right after a poll', async () => {
    link(P1, '11', 'alicetv');
    await pollTwitch(db, fakeTwitchApi({}), T0);
    expect(twitchCacheStale(db, T0)).toBe(false);
  });

  it('goes stale once the last poll is old enough', async () => {
    link(P1, '11', 'alicetv');
    await pollTwitch(db, fakeTwitchApi({}), T0);
    expect(twitchCacheStale(db, new Date(T0.getTime() + TWITCH_STALE_MS - 1))).toBe(false);
    expect(twitchCacheStale(db, new Date(T0.getTime() + TWITCH_STALE_MS + 1))).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/twitchPoll.test.ts`
Expected: FAIL, cannot find module `../src/twitchPoll.js`.

- [ ] **Step 3: Write the implementation**

Create `src/twitchPoll.ts`:

```ts
import type { DB } from './db.js';
import type { TwitchApi } from './twitch/api.js';

/** Helix takes 100 channels per request, so the whole community is one call
 *  whatever the interval. Polling faster than this buys nothing real: Twitch's
 *  own stream data lags by around a minute. */
export const TWITCH_POLL_MS = 60_000;

/** How old the last successful poll may be before the read path stops
 *  claiming anyone is live. A wrong "offline" is a shrug; a LIVE badge stuck
 *  on forever because the poller died makes the page untrustworthy. */
export const TWITCH_STALE_MS = 10 * 60_000;

interface LinkedRow { steamid: string; twitch_id: string; twitch_name: string | null }

/**
 * Refresh the cache for every linked channel.
 *
 * Failure leaves the cache exactly as it was, checked_at included, so the
 * staleness check can notice. Writing checked_at on a failed poll would be the
 * one thing that defeats it.
 */
export async function pollTwitch(db: DB, api: TwitchApi, now: Date = new Date()): Promise<void> {
  // An unlinked player's row is deleted here as well as in unlinkTwitch, so a
  // row orphaned by any other path (a merge, a manual edit) still goes away.
  db.exec(`DELETE FROM twitch_status WHERE player_id NOT IN
           (SELECT steamid FROM players WHERE twitch_id IS NOT NULL)`);

  const linked = db.prepare(
    'SELECT steamid, twitch_id, twitch_name FROM players WHERE twitch_id IS NOT NULL',
  ).all() as LinkedRow[];
  if (linked.length === 0) return;

  let streams;
  try {
    streams = await api.getStreams(linked.map((r) => r.twitch_id));
  } catch (err) {
    console.error('[twitch] poll failed, keeping the previous cache:', err);
    return;
  }

  const byId = new Map(streams.map((s) => [s.userId, s]));
  const iso = now.toISOString();

  const write = db.transaction(() => {
    const upsert = db.prepare(
      `INSERT INTO twitch_status
         (player_id, is_live, title, game_name, viewers, thumbnail, started_at, last_live_at, checked_at)
       VALUES (@player_id, @is_live, @title, @game_name, @viewers, @thumbnail, @started_at, @last_live_at, @checked_at)
       ON CONFLICT(player_id) DO UPDATE SET
         is_live = excluded.is_live,
         title = excluded.title,
         game_name = excluded.game_name,
         viewers = excluded.viewers,
         thumbnail = excluded.thumbnail,
         started_at = excluded.started_at,
         -- Only ever moves forward. An offline poll must not erase when they
         -- were last seen, because that is what orders the offline tier.
         last_live_at = COALESCE(excluded.last_live_at, twitch_status.last_live_at),
         checked_at = excluded.checked_at`,
    );
    const rename = db.prepare('UPDATE players SET twitch_name = ? WHERE steamid = ?');
    for (const row of linked) {
      const s = byId.get(row.twitch_id);
      upsert.run({
        player_id: row.steamid,
        is_live: s ? 1 : 0,
        title: s?.title ?? null,
        game_name: s?.gameName ?? null,
        viewers: s?.viewers ?? null,
        thumbnail: s?.thumbnailUrl ?? null,
        started_at: s?.startedAt ?? null,
        last_live_at: s ? iso : null,
        checked_at: iso,
      });
      // The login is a cache of something that changes. This is the only place
      // it gets refreshed, and it is free here because we already have it.
      if (s && s.userLogin && s.userLogin !== row.twitch_name) rename.run(s.userLogin, row.steamid);
    }
  });
  write();
}

/** True when nothing may be reported as live. Also true when the cache is
 *  empty, which covers a process that has not polled once yet. */
export function twitchCacheStale(db: DB, now: Date = new Date()): boolean {
  const row = db.prepare('SELECT MAX(checked_at) AS last FROM twitch_status')
    .get() as { last: string | null };
  if (!row.last) return true;
  const last = Date.parse(row.last);
  if (!Number.isFinite(last)) return true;
  return now.getTime() - last > TWITCH_STALE_MS;
}

/** Start polling. Returns the stop function for the server's onClose hook. */
export function startTwitchPoll(db: DB, api: TwitchApi): () => void {
  const tick = () => {
    void pollTwitch(db, api).catch((err) => {
      console.error('[twitch] poll threw:', err);
    });
  };
  tick();
  const timer = setInterval(tick, TWITCH_POLL_MS);
  // Never hold the process open for a stream status.
  timer.unref?.();
  return () => clearInterval(timer);
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/twitchPoll.test.ts`
Expected: PASS.

- [ ] **Step 5: Start it in `server.ts`**

Beside the other timers, after `twitchApi` is built:

```ts
  // Only when a real API exists. Tests inject a fake and drive pollTwitch
  // directly, so starting a timer for them would be noise that outlives the
  // test.
  const stopTwitchPoll = twitchApi && deps.config.twitch
    ? startTwitchPoll(deps.db, twitchApi)
    : null;
```

and in the existing `onClose` hook, beside `clearInterval(reaper)`:

```ts
    stopTwitchPoll?.();
```

Import `startTwitchPoll` from `./twitchPoll.js`.

- [ ] **Step 6: Full test and commit**

```bash
npm run typecheck
npx vitest run
git add src/twitchPoll.ts src/server.ts tests/twitchPoll.test.ts
git commit -m "Poll Twitch for who is live, and notice when the cache goes stale

A failed poll leaves the cache exactly as it was, checked_at included. Writing
checked_at on a failure is the one thing that would defeat the staleness
check, and the staleness check is what stops a LIVE badge from being stuck on
forever after the poller dies.

last_live_at only ever moves forward, because an offline poll must not erase
when someone was last seen: that is the value the offline tier is ordered by.

The poll also deletes status rows for players who are no longer linked, so a
row orphaned by any path at all, not only unlinkTwitch, goes away."
```

---

### Task 10: The streams read model

**Files:**
- Create: `src/streamsView.ts`
- Modify: `src/matchmaker.ts` (add a public accessor for engaged steamids)
- Test: `tests/streamsView.test.ts` (create)

**Interfaces:**
- Consumes: `twitchCacheStale` from `src/twitchPoll.ts`.
- Produces:
  - `interface StreamMatch { id: number; campaign: string; map: string | null }`
  - `interface StreamCard { steamid: string; name: string; avatar: string | null; twitchName: string; title: string; gameName: string; viewers: number; thumbnail: string; startedAt: string | null; match: StreamMatch | null }`
  - `interface OfflineCard { steamid: string; name: string; avatar: string | null; twitchName: string; lastLiveAt: string | null }`
  - `interface StreamsView { stale: boolean; inPug: StreamCard[]; live: StreamCard[]; offline: OfflineCard[]; offlineTotal: number }`
  - `OFFLINE_CAP = 24`
  - `streamsView(db: DB, opts: { engaged: string[]; all?: boolean; now?: Date }): StreamsView`
  - `Matchmaker.engagedIds(): string[]`

- [ ] **Step 1: Write the failing test**

Create `tests/streamsView.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer } from '../src/players.js';
import { OFFLINE_CAP, streamsView } from '../src/streamsView.js';

const T0 = new Date('2026-09-20T12:00:00.000Z');
let db: DB;

function player(id: string, name: string) {
  upsertPlayer(db, id, name, null);
}

function linked(id: string, twitchId: string, login: string) {
  db.prepare('UPDATE players SET twitch_id = ?, twitch_name = ? WHERE steamid = ?')
    .run(twitchId, login, id);
}

function status(id: string, live: boolean, over: Partial<Record<string, unknown>> = {}) {
  db.prepare(
    `INSERT INTO twitch_status
       (player_id, is_live, title, game_name, viewers, thumbnail, started_at, last_live_at, checked_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    id, live ? 1 : 0,
    over.title ?? 'streaming', over.game_name ?? 'Left 4 Dead',
    over.viewers ?? 10, over.thumbnail ?? 'https://t/{width}x{height}.jpg',
    over.started_at ?? T0.toISOString(),
    over.last_live_at ?? (live ? T0.toISOString() : null),
    over.checked_at ?? T0.toISOString(),
  );
}

function liveMatch(matchId: number, campaign: string, map: string, roster: string[]) {
  db.prepare("INSERT INTO matches (id, season_id, state, campaign) VALUES (?,1,'live',?)")
    .run(matchId, campaign);
  db.prepare('INSERT INTO match_live (match_id, current_map, last_seen) VALUES (?,?,?)')
    .run(matchId, map, T0.toISOString());
  for (const [i, p] of roster.entries()) {
    db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?,?,?)')
      .run(matchId, p, i < 4 ? 'a' : 'b');
  }
}

beforeEach(() => {
  db = openDb(':memory:');
});

describe('streamsView', () => {
  it('is empty and stale before anything has polled', () => {
    const v = streamsView(db, { engaged: [], now: T0 });
    expect(v).toEqual({ stale: true, inPug: [], live: [], offline: [], offlineTotal: 0 });
  });

  it('puts a live streamer who is in queue in the top tier', () => {
    player('1', 'alice');
    linked('1', '11', 'alicetv');
    status('1', true);
    const v = streamsView(db, { engaged: ['1'], now: T0 });
    expect(v.inPug.map((s) => s.steamid)).toEqual(['1']);
    expect(v.live).toEqual([]);
    expect(v.inPug[0].match).toBe(null);
  });

  it('puts a live streamer on a live roster in the top tier, with the match', () => {
    player('1', 'alice');
    linked('1', '11', 'alicetv');
    status('1', true);
    liveMatch(7, 'Blood Harvest', 'l4d_farm01_hilltop', ['1']);
    const v = streamsView(db, { engaged: [], now: T0 });
    expect(v.inPug[0].match).toEqual({ id: 7, campaign: 'Blood Harvest', map: 'l4d_farm01_hilltop' });
  });

  it('puts a live streamer doing neither in the second tier', () => {
    player('1', 'alice');
    linked('1', '11', 'alicetv');
    status('1', true);
    const v = streamsView(db, { engaged: [], now: T0 });
    expect(v.inPug).toEqual([]);
    expect(v.live.map((s) => s.steamid)).toEqual(['1']);
  });

  it('sorts each live tier by viewers, descending', () => {
    for (const [id, viewers] of [['1', 5], ['2', 50], ['3', 20]] as const) {
      player(String(id), `p${id}`);
      linked(String(id), `t${id}`, `login${id}`);
      status(String(id), true, { viewers });
    }
    const v = streamsView(db, { engaged: [], now: T0 });
    expect(v.live.map((s) => s.viewers)).toEqual([50, 20, 5]);
  });

  it('lists offline streamers most recently live first, nulls last', () => {
    player('1', 'a'); linked('1', 't1', 'l1');
    status('1', false, { last_live_at: '2026-09-18T00:00:00.000Z' });
    player('2', 'b'); linked('2', 't2', 'l2');
    status('2', false, { last_live_at: '2026-09-19T00:00:00.000Z' });
    player('3', 'c'); linked('3', 't3', 'l3');
    status('3', false, { last_live_at: null });
    const v = streamsView(db, { engaged: [], now: T0 });
    expect(v.offline.map((o) => o.steamid)).toEqual(['2', '1', '3']);
  });

  it('caps the offline tier and reports the true total', () => {
    for (let i = 0; i < OFFLINE_CAP + 5; i += 1) {
      const id = String(1000 + i);
      player(id, `p${i}`);
      linked(id, `t${i}`, `l${i}`);
      status(id, false, { last_live_at: `2026-09-${String(10 + (i % 10)).padStart(2, '0')}T00:00:00.000Z` });
    }
    const v = streamsView(db, { engaged: [], now: T0 });
    expect(v.offline.length).toBe(OFFLINE_CAP);
    expect(v.offlineTotal).toBe(OFFLINE_CAP + 5);
  });

  it('returns them all when asked', () => {
    for (let i = 0; i < OFFLINE_CAP + 5; i += 1) {
      const id = String(1000 + i);
      player(id, `p${i}`);
      linked(id, `t${i}`, `l${i}`);
      status(id, false);
    }
    expect(streamsView(db, { engaged: [], all: true, now: T0 }).offline.length).toBe(OFFLINE_CAP + 5);
  });

  it('reports nobody live once the cache is stale, and says so', () => {
    player('1', 'alice');
    linked('1', '11', 'alicetv');
    status('1', true);
    const late = new Date(T0.getTime() + 11 * 60_000);
    const v = streamsView(db, { engaged: ['1'], now: late });
    expect(v.stale).toBe(true);
    expect(v.inPug).toEqual([]);
    expect(v.live).toEqual([]);
    // Still listed, because "we do not know" is not "offline forever".
    expect(v.offline.map((o) => o.steamid)).toEqual(['1']);
  });

  it('ignores a player who never linked', () => {
    player('1', 'alice');
    expect(streamsView(db, { engaged: ['1'], now: T0 }).offline).toEqual([]);
  });

  it('ignores a roster on a match that is not live', () => {
    player('1', 'alice');
    linked('1', '11', 'alicetv');
    status('1', true);
    db.prepare("INSERT INTO matches (id, season_id, state, campaign) VALUES (9,1,'completed','Blood Harvest')").run();
    db.prepare("INSERT INTO match_players (match_id, player_id, team) VALUES (9,'1','a')").run();
    const v = streamsView(db, { engaged: [], now: T0 });
    expect(v.inPug).toEqual([]);
    expect(v.live.map((s) => s.steamid)).toEqual(['1']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/streamsView.test.ts`
Expected: FAIL, cannot find module `../src/streamsView.js`.

- [ ] **Step 3: Write the implementation**

Create `src/streamsView.ts`:

```ts
import type { DB } from './db.js';
import { twitchCacheStale } from './twitchPoll.js';

/** How many offline channels the page shows before "show all". The page has to
 *  stay a list of streamers rather than becoming an avatar wall of everyone
 *  who ever linked, and it grows with the community while the page does not. */
export const OFFLINE_CAP = 24;

export interface StreamMatch { id: number; campaign: string; map: string | null }

export interface StreamCard {
  steamid: string;
  name: string;
  avatar: string | null;
  twitchName: string;
  title: string;
  gameName: string;
  viewers: number;
  /** Twitch's template, {width}x{height} intact. Substituted at render. */
  thumbnail: string;
  startedAt: string | null;
  /** The PUG this stream is of, when there is one. */
  match: StreamMatch | null;
}

export interface OfflineCard {
  steamid: string;
  name: string;
  avatar: string | null;
  twitchName: string;
  lastLiveAt: string | null;
}

export interface StreamsView {
  /** True when the poll cache is too old to claim anyone is live. */
  stale: boolean;
  inPug: StreamCard[];
  live: StreamCard[];
  offline: OfflineCard[];
  /** How many offline channels exist, which is not offline.length once capped. */
  offlineTotal: number;
}

interface Row {
  steamid: string; name: string; avatar: string | null; twitch_name: string;
  is_live: number | null; title: string | null; game_name: string | null;
  viewers: number | null; thumbnail: string | null; started_at: string | null;
  last_live_at: string | null;
}

/**
 * The three tiers.
 *
 * `engaged` is the set of steamids in the queue or in a lobby right now. It is
 * passed in rather than read, because the queue lives in memory in the
 * matchmaker and nothing good comes of making the query layer reach for it.
 */
export function streamsView(
  db: DB,
  opts: { engaged: string[]; all?: boolean; now?: Date },
): StreamsView {
  const now = opts.now ?? new Date();
  const stale = twitchCacheStale(db, now);

  const rows = db.prepare(
    `SELECT p.steamid, p.name, p.avatar, p.twitch_name,
            t.is_live, t.title, t.game_name, t.viewers, t.thumbnail, t.started_at, t.last_live_at
     FROM players p
     LEFT JOIN twitch_status t ON t.player_id = p.steamid
     WHERE p.twitch_id IS NOT NULL AND p.twitch_name IS NOT NULL`,
  ).all() as Row[];

  // Who is on a live match roster, and which match. A player on two live
  // matches is impossible, so first wins and the query is not deduplicated.
  const liveMatches = db.prepare(
    `SELECT mp.player_id, m.id, m.campaign, ml.current_map
     FROM match_players mp
     JOIN matches m ON m.id = mp.match_id
     LEFT JOIN match_live ml ON ml.match_id = m.id
     WHERE m.state = 'live'`,
  ).all() as { player_id: string; id: number; campaign: string; current_map: string | null }[];
  const matchOf = new Map<string, StreamMatch>();
  for (const r of liveMatches) {
    if (!matchOf.has(r.player_id)) {
      matchOf.set(r.player_id, { id: r.id, campaign: r.campaign, map: r.current_map });
    }
  }

  const engaged = new Set(opts.engaged);

  const inPug: StreamCard[] = [];
  const live: StreamCard[] = [];
  const offline: OfflineCard[] = [];

  for (const r of rows) {
    // A stale cache means we do not know, and "we do not know" is reported as
    // not-live rather than as a claim. The channel is still listed, because
    // dropping it entirely would make the page empty whenever the poller
    // hiccups.
    const isLive = !stale && r.is_live === 1;
    if (!isLive) {
      offline.push({
        steamid: r.steamid,
        name: r.name,
        avatar: r.avatar,
        twitchName: r.twitch_name,
        lastLiveAt: r.last_live_at,
      });
      continue;
    }
    const match = matchOf.get(r.steamid) ?? null;
    const card: StreamCard = {
      steamid: r.steamid,
      name: r.name,
      avatar: r.avatar,
      twitchName: r.twitch_name,
      title: r.title ?? '',
      gameName: r.game_name ?? '',
      viewers: r.viewers ?? 0,
      thumbnail: r.thumbnail ?? '',
      startedAt: r.started_at,
      match,
    };
    if (match || engaged.has(r.steamid)) inPug.push(card);
    else live.push(card);
  }

  const byViewers = (a: StreamCard, b: StreamCard) => b.viewers - a.viewers;
  inPug.sort(byViewers);
  live.sort(byViewers);

  // Most recently live first. Never seen live sorts last rather than first,
  // which is what an empty string would do.
  offline.sort((a, b) => (b.lastLiveAt ?? '').localeCompare(a.lastLiveAt ?? ''));

  return {
    stale,
    inPug,
    live,
    offline: opts.all ? offline : offline.slice(0, OFFLINE_CAP),
    offlineTotal: offline.length,
  };
}
```

- [ ] **Step 4: Add the matchmaker accessor**

In `src/matchmaker.ts`, add a public method beside the other public methods:

```ts
  /** Everyone waiting for a match right now: in the queue, or in a lobby that
   *  has not gone live yet. Read by the streams page to decide whether a live
   *  stream belongs in the top tier. Both collections are in memory, so this
   *  is the only way out of the matchmaker. */
  engagedIds(): string[] {
    return [...new Set([...this.queue.list(), ...this.playerLobby.keys()])];
  }
```

If `playerLobby` is not a `Map` keyed by steamid, adapt to whatever it is; the requirement is only that the returned array holds every steamid that is queued or in a lobby.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/streamsView.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/streamsView.ts src/matchmaker.ts tests/streamsView.test.ts
git commit -m "Build the three-tier streams read model

The top tier is what this page has that elmt.gg cannot: it knows which streams
are of a PUG happening right now, from the queue and the live rosters we
already hold.

A stale cache reports nobody as live but still lists everybody, because we do
not know is not the same as offline, and dropping the rows would blank the
page every time the poller hiccups.

engaged is passed in rather than read. The queue lives in memory in the
matchmaker and nothing good comes of making the query layer reach for it."
```

---

### Task 11: The streams API and page

**Files:**
- Create: `web/src/routes/Streams.tsx`
- Create: `web/src/components/StreamStrip.tsx`
- Modify: `src/routes/api.ts` (add `GET /api/streams`)
- Modify: `web/src/api.ts` (types and `api.streams()`)
- Modify: `web/src/main.tsx` (route and nav)
- Modify: `web/src/routes/Live.tsx` (mount the strip)
- Modify: the stylesheet holding the page styles
- Test: `tests/streamsApi.test.ts` (create)

**Interfaces:**
- Consumes: `streamsView`, `OFFLINE_CAP` from `src/streamsView.ts`; `Matchmaker.engagedIds()`.
- Produces: `GET /api/streams?all=1`, returning `StreamsView` as JSON; `api.streams(all?: boolean)`; route `/streams`.

- [ ] **Step 1: Write the failing test**

Create `tests/streamsApi.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { upsertPlayer } from '../src/players.js';
import { stubOrchestrator } from './helpers.js';

const P1 = '76561198000000001';
let db: DB;
let app: FastifyInstance;

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({
    config: loadConfig({}), db, orchestrator: stubOrchestrator(),
    verifyLogin: async () => P1,
    fetchPersona: async () => ({ name: 'alice', avatar: null }),
    serverExec: async () => {},
  });
});
afterEach(async () => { await app.close(); });

describe('GET /api/streams', () => {
  it('is public and empty before anyone links', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/streams' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ stale: true, inPug: [], live: [], offline: [], offlineTotal: 0 });
  });

  it('lists a linked player, and never leaks their twitch id', async () => {
    upsertPlayer(db, P1, 'alice', null);
    db.prepare("UPDATE players SET twitch_id = '11', twitch_name = 'alicetv' WHERE steamid = ?").run(P1);
    db.prepare(
      `INSERT INTO twitch_status (player_id, is_live, viewers, checked_at, last_live_at)
       VALUES (?, 1, 18, ?, ?)`,
    ).run(P1, new Date().toISOString(), new Date().toISOString());
    const res = await app.inject({ method: 'GET', url: '/api/streams' });
    const body = res.json();
    expect(body.live[0].twitchName).toBe('alicetv');
    expect(JSON.stringify(body)).not.toContain('"11"');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/streamsApi.test.ts`
Expected: FAIL, 404 on `/api/streams`.

- [ ] **Step 3: Add the route**

In `src/routes/api.ts`, import `streamsView` and register:

```ts
  /** Public: the whole point is a page anyone can open. No session is read,
   *  and no twitch id is serialised; the login is the only Twitch identifier
   *  that leaves the server, because it is the only one that is already
   *  public. */
  app.get('/api/streams', async (req) => {
    const { all } = req.query as { all?: string };
    return streamsView(db, { engaged: matchmaker.engagedIds(), all: all === '1' });
  });
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/streamsApi.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the web types and client call**

In `web/src/api.ts`:

```ts
export interface StreamMatch { id: number; campaign: string; map: string | null }

export interface StreamCard {
  steamid: string;
  name: string;
  avatar: string | null;
  twitchName: string;
  title: string;
  gameName: string;
  viewers: number;
  thumbnail: string;
  startedAt: string | null;
  match: StreamMatch | null;
}

export interface OfflineCard {
  steamid: string;
  name: string;
  avatar: string | null;
  twitchName: string;
  lastLiveAt: string | null;
}

export interface StreamsView {
  stale: boolean;
  inPug: StreamCard[];
  live: StreamCard[];
  offline: OfflineCard[];
  offlineTotal: number;
}
```

and on the `api` object:

```ts
  streams: (all = false) => get<StreamsView>(`/api/streams${all ? '?all=1' : ''}`),
```

- [ ] **Step 6: Write the page**

Create `web/src/routes/Streams.tsx`:

```tsx
import { useEffect, useState } from 'preact/hooks';
import { api, type OfflineCard, type StreamCard, type StreamsView } from '../api';
import { campaignName, mapName } from '../format';
import { Empty, Panel } from '../components/bits';
import { PageHeader } from '../components/PageHeader';

/** Matches the server's poll. Polling faster shows nothing newer. */
const POLL_MS = 60_000;

/** Twitch hands back a template. Substituting here rather than server-side
 *  means one stored value serves any size, and the cache buster is what stops
 *  their CDN serving a frame from twenty minutes ago. */
function thumb(card: StreamCard, w: number, h: number): string {
  if (!card.thumbnail) return '';
  const url = card.thumbnail.replace('{width}', String(w)).replace('{height}', String(h));
  return `${url}${url.includes('?') ? '&' : '?'}t=${Math.floor(Date.now() / POLL_MS)}`;
}

function uptime(startedAt: string | null): string {
  if (!startedAt) return '';
  const ms = Date.now() - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function lastLive(iso: string | null): string {
  if (!iso) return 'never seen live';
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (!Number.isFinite(days)) return 'never seen live';
  if (days <= 0) return 'live earlier today';
  if (days === 1) return 'live yesterday';
  return `last live ${days} days ago`;
}

function StreamTile({ card, big }: { card: StreamCard; big: boolean }) {
  const href = `https://www.twitch.tv/${encodeURIComponent(card.twitchName)}`;
  return (
    <a class={`streamtile ${big ? 'streamtile--big' : ''}`} href={href} target="_blank" rel="noopener noreferrer">
      <div class="streamtile__shot">
        {card.thumbnail
          ? <img src={thumb(card, big ? 440 : 320, big ? 248 : 180)} alt="" loading="lazy" />
          : <div class="streamtile__noshot" />}
        <span class="streamtile__badge">LIVE</span>
        <span class="streamtile__viewers">{card.viewers.toLocaleString()} watching</span>
        {card.startedAt && <span class="streamtile__uptime">{uptime(card.startedAt)}</span>}
      </div>
      <div class="streamtile__body">
        {card.match && (
          <span class="streamtile__match">
            PUG #{card.match.id} · {campaignName(card.match.campaign)}
            {card.match.map ? ` · ${mapName(card.match.map)}` : ''}
          </span>
        )}
        <div class="streamtile__who">
          {card.avatar && <img class="streamtile__avatar" src={card.avatar} alt="" />}
          <div>
            <div class="streamtile__name">{card.name}</div>
            <div class="streamtile__channel">{card.twitchName}</div>
          </div>
        </div>
        {card.title && <p class="streamtile__title">{card.title}</p>}
      </div>
    </a>
  );
}

function OfflineTile({ card }: { card: OfflineCard }) {
  return (
    <a
      class="offlinetile"
      href={`https://www.twitch.tv/${encodeURIComponent(card.twitchName)}`}
      target="_blank"
      rel="noopener noreferrer"
    >
      {card.avatar
        ? <img class="offlinetile__avatar" src={card.avatar} alt="" loading="lazy" />
        : <div class="offlinetile__avatar offlinetile__avatar--blank" />}
      <div class="offlinetile__name">{card.name}</div>
      <div class="offlinetile__when">{lastLive(card.lastLiveAt)}</div>
    </a>
  );
}

export function Streams() {
  const [view, setView] = useState<StreamsView | null>(null);
  const [all, setAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await api.streams(all);
        if (!cancelled) setView(res);
      } catch {
        // Keep the last good render rather than blanking the page on a blip,
        // the same choice Live makes.
      }
    };
    void load();
    const t = setInterval(load, POLL_MS);
    return () => { cancelled = true; clearInterval(t); };
  }, [all]);

  if (view === null) return <div class="page page--list" />;

  const nothing = !view.inPug.length && !view.live.length && !view.offline.length;

  return (
    <div class="page page--list">
      <PageHeader eyebrow="Riverside" title="Streams" />

      {view.stale && (
        <Panel>
          <Empty>Twitch status is unavailable right now, so nobody is shown as live.</Empty>
        </Panel>
      )}

      {view.inPug.length > 0 && (
        <section class="streamsec">
          <h2 class="streamsec__head">Live in a PUG</h2>
          <div class="streamgrid streamgrid--big">
            {view.inPug.map((c) => <StreamTile key={c.steamid} card={c} big />)}
          </div>
        </section>
      )}

      {view.live.length > 0 && (
        <section class="streamsec">
          <h2 class="streamsec__head">Live</h2>
          <div class="streamgrid">
            {view.live.map((c) => <StreamTile key={c.steamid} card={c} big={false} />)}
          </div>
        </section>
      )}

      {view.offline.length > 0 && (
        <section class="streamsec">
          <h2 class="streamsec__head">Offline</h2>
          <div class="offlinegrid">
            {view.offline.map((c) => <OfflineTile key={c.steamid} card={c} />)}
          </div>
          {!all && view.offlineTotal > view.offline.length && (
            <button class="btn btn--ghost" onClick={() => setAll(true)}>
              Show all {view.offlineTotal}
            </button>
          )}
        </section>
      )}

      {nothing && (
        <Panel>
          <Empty>
            Nobody has linked a Twitch channel yet. Connect yours from your profile and you
            will show up here.
          </Empty>
        </Panel>
      )}
    </div>
  );
}
```

- [ ] **Step 7: Write the strip**

Create `web/src/components/StreamStrip.tsx`:

```tsx
import { useEffect, useState } from 'preact/hooks';
import { api, type StreamCard } from '../api';

const POLL_MS = 60_000;
const SHOWN = 5;

/** One line at the top of Live. Renders nothing at all when nobody is live,
 *  because that page is already a long scroll and a quiet night should leave
 *  it exactly as it was. Not sticky, for the same reason. */
export function StreamStrip() {
  const [cards, setCards] = useState<StreamCard[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const v = await api.streams();
        if (!cancelled) setCards([...v.inPug, ...v.live]);
      } catch {
        // Leave whatever is up.
      }
    };
    void load();
    const t = setInterval(load, POLL_MS);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  if (cards.length === 0) return null;

  return (
    <a class="streamstrip" href="/streams">
      <span class="streamstrip__dot" aria-hidden="true" />
      <span class="streamstrip__avatars">
        {cards.slice(0, SHOWN).map((c) => (
          c.avatar
            ? <img key={c.steamid} class="streamstrip__avatar" src={c.avatar} alt={c.name} />
            : <span key={c.steamid} class="streamstrip__avatar streamstrip__avatar--blank" />
        ))}
      </span>
      <span class="streamstrip__text">
        {cards.length === 1 ? '1 streaming now' : `${cards.length} streaming now`}
      </span>
    </a>
  );
}
```

- [ ] **Step 8: Mount both**

In `web/src/main.tsx`, import and add the route beside `/live`:

```tsx
import { Streams } from './routes/Streams';
```
```tsx
          <Route path="/streams" component={Streams} />
```

Add a nav entry next to the existing Live one, matching how the other links are written in that file.

In `web/src/routes/Live.tsx`, import `StreamStrip` and render it as the first child inside the page div, above `<PageHeader ... />`:

```tsx
      <StreamStrip />
```

- [ ] **Step 9: Add the styles**

Append to the same stylesheet used in Task 6:

```css
.streamsec { margin: 1.25rem 0; }
.streamsec__head { font-size: .95rem; letter-spacing: .04em; text-transform: uppercase; opacity: .7; margin: 0 0 .6rem; }

.streamgrid { display: grid; gap: .9rem; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); }
.streamgrid--big { grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); }

.streamtile { display: block; text-decoration: none; border: 1px solid var(--line, #333); border-radius: 10px; overflow: hidden; }
.streamtile:hover { border-color: var(--accent, #888); }
.streamtile__shot { position: relative; aspect-ratio: 16 / 9; background: #111; }
.streamtile__shot img { width: 100%; height: 100%; object-fit: cover; display: block; }
.streamtile__noshot { width: 100%; height: 100%; }
.streamtile__badge { position: absolute; top: .5rem; left: .5rem; background: #e91916; color: #fff; font-size: .7rem; font-weight: 700; padding: .1rem .4rem; border-radius: 3px; }
.streamtile__viewers, .streamtile__uptime { position: absolute; bottom: .5rem; background: rgba(0,0,0,.72); color: #fff; font-size: .72rem; padding: .1rem .4rem; border-radius: 3px; }
.streamtile__viewers { left: .5rem; }
.streamtile__uptime { right: .5rem; }
.streamtile__body { padding: .6rem .7rem .7rem; display: grid; gap: .4rem; }
.streamtile__match { font-size: .75rem; font-weight: 700; color: #a970ff; letter-spacing: .02em; }
.streamtile__who { display: flex; gap: .5rem; align-items: center; }
.streamtile__avatar { width: 32px; height: 32px; border-radius: 50%; }
.streamtile__name { font-weight: 600; }
.streamtile__channel { font-size: .75rem; opacity: .6; }
.streamtile__title { margin: 0; font-size: .82rem; opacity: .8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.offlinegrid { display: grid; gap: .8rem; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); }
.offlinetile { text-align: center; text-decoration: none; opacity: .72; }
.offlinetile:hover { opacity: 1; }
.offlinetile__avatar { width: 56px; height: 56px; border-radius: 50%; }
.offlinetile__avatar--blank { display: inline-block; background: var(--line, #333); }
.offlinetile__name { font-size: .82rem; font-weight: 600; margin-top: .3rem; }
.offlinetile__when { font-size: .7rem; opacity: .6; }

.streamstrip {
  display: flex; gap: .5rem; align-items: center; text-decoration: none;
  padding: .4rem .6rem; margin-bottom: .6rem;
  border: 1px solid var(--line, #333); border-radius: 999px; font-size: .82rem;
}
.streamstrip:hover { border-color: #a970ff; }
.streamstrip__dot { width: 8px; height: 8px; border-radius: 50%; background: #e91916; }
.streamstrip__avatars { display: flex; }
.streamstrip__avatar { width: 22px; height: 22px; border-radius: 50%; margin-left: -6px; border: 2px solid var(--bg, #111); }
.streamstrip__avatar:first-child { margin-left: 0; }
.streamstrip__avatar--blank { display: inline-block; background: var(--line, #333); }

@media (max-width: 520px) {
  .streamgrid, .streamgrid--big { grid-template-columns: 1fr; }
}
```

- [ ] **Step 10: Verify the routes test still passes**

`web/src/routes/routes.test.tsx` enumerates routes; if it asserts a fixed list, add `/streams` to it.

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 11: Typecheck, build, commit**

```bash
npm run typecheck
npm run build
git add src/routes/api.ts web/src tests/streamsApi.test.ts
git commit -m "Ship the streams page and the strip on Live

/api/streams is public, because a page anyone can open is the point, and it
serialises the twitch login and never the twitch id: the login is the only
Twitch identifier that is already public. A test pins that the id does not
appear in the response.

The strip renders nothing at all when nobody is live, and is not sticky. That
page is already a long scroll with three games of replay viewers, which was
the complaint that split this off /live in the first place."
```

---

## Self-review

**Spec coverage.** Every section of the spec's phases 1 to 3 maps to a task: data model (1), country list (2, an implied dependency of the country field), validation (3), read/write (4), API (5), profile UI (6), Twitch config and client (7), OAuth (8), poller (9), read model (10), page and strip (11). Chemistry (spec phase 4), endorsements (phase 5) and VOD links (phase 6) are deliberately out of scope for this plan and get their own, as the scope check requires.

**Known gap, carried deliberately:** the spec's rate limiting note is not addressed here, because the spec says it is not addressed here. The two new write endpoints are listed in the spec's security section so they are picked up by the audit's rate limiting work.

**Type consistency.** `StreamCard`, `OfflineCard`, `StreamsView`, `StreamMatch` are defined once in Task 10 and mirrored verbatim in Task 11's web types. `SocialLink` is defined in Task 4 and mirrored in Task 5's web types. `Validated` is defined in Task 3 and consumed in Task 4. `TwitchApi` is defined in Task 7 and consumed in Tasks 8, 9 and the fake.

**Placeholder scan.** No TBDs. The two places that say "adapt to whatever it is" (the `Headliner` internals in Task 6 Step 9, and `playerLobby` in Task 10 Step 4) name the exact requirement rather than leaving it open, because the surrounding code was not read line by line and inventing its current shape would be worse than naming the contract.
