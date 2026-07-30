# L4D1 PUG Backend Core — Implementation Plan (Sub-project 1 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The `pug-web` backend core: SQLite schema, Steam login with invite gate, the queue → ready-check → map-vote → team-assignment pipeline, websocket refresh pushes, a minimal working web UI, and a dev mode for testing without 8 real humans.

**Architecture:** Single Node.js/TypeScript monolith (Fastify) on SQLite via better-sqlite3. Match pipeline state (queue, lobbies, votes) is in-memory by design; only players/ratings/matches persist. Server↔game communication (RCON/logaddress) is **sub-project 2** — here the orchestrator is a no-op stub and matches end at state `configuring`. Full system spec: `docs/superpowers/specs/2026-07-30-l4d1-pug-system-design.md` (read it first).

**Tech Stack:** Node 22, TypeScript (strict, ESM, run via tsx — no build step), Fastify 5 (@fastify/cookie, @fastify/static, @fastify/websocket), better-sqlite3, openskill, vitest.

**Refinements vs spec (intentional):**
- The spec lists match states `ready_check → map_vote → configuring → live → completed/aborted`. The first two are **in-memory lobby phases**; a `matches` row is only created at `configuring`. The DB CHECK constraint therefore only allows the persisted four.
- Websocket messages carry no data: every state change broadcasts `refresh` and clients re-fetch `GET /api/state`. Richer events are YAGNI for now.
- SteamIDs are stored as SteamID64 strings everywhere. Conversion to `STEAM_1:X:Y` is sub-project 2's problem.

**Project location:** `/home/volence/l4d/pug` — a NEW git repository created in Task 1. All paths below are relative to it. Run all commands from inside it.

---

### Task 1: Scaffold repository and toolchain

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `tests/smoke.test.ts`
- Copy in: `docs/superpowers/specs/2026-07-30-l4d1-pug-system-design.md`, `docs/superpowers/plans/2026-07-30-pug-backend-core.md`

- [ ] **Step 1: Create repo and directories**

```bash
mkdir -p /home/volence/l4d/pug && cd /home/volence/l4d/pug
git init
mkdir -p src src/routes public tests docs/superpowers/specs docs/superpowers/plans data
cp /home/volence/l4d/docs/superpowers/specs/2026-07-30-l4d1-pug-system-design.md docs/superpowers/specs/
cp /home/volence/l4d/docs/superpowers/plans/2026-07-30-pug-backend-core.md docs/superpowers/plans/
```

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "pug",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "DEV_MODE=1 tsx watch src/index.ts",
    "start": "tsx src/index.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 3: Install dependencies**

```bash
npm install fastify @fastify/cookie @fastify/static @fastify/websocket better-sqlite3 openskill
npm install -D typescript tsx vitest @types/node @types/better-sqlite3
```

- [ ] **Step 4: Write `tsconfig.json` and `.gitignore`**

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "tests"]
}
```

`.gitignore`:
```
node_modules/
data/
*.db
*.db-*
```

- [ ] **Step 5: Write smoke test `tests/smoke.test.ts`**

```ts
import { describe, it, expect } from 'vitest';

describe('toolchain', () => {
  it('runs tests', () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 6: Verify toolchain**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 1 test passes; tsc exits clean.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: scaffold pug repo (fastify/ts/sqlite toolchain)"
```

---

### Task 2: Config and campaign constants

**Files:**
- Create: `src/config.ts`, `src/campaigns.ts`
- Test: `tests/config.test.ts`

- [ ] **Step 1: Write failing test `tests/config.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';
import { CAMPAIGNS } from '../src/campaigns.js';

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig({});
    expect(c.port).toBe(8080);
    expect(c.publicUrl).toBe('http://localhost:8080');
    expect(c.devMode).toBe(false);
    expect(c.adminSteamIds).toEqual([]);
  });

  it('parses env values', () => {
    const c = loadConfig({
      PORT: '9000',
      DEV_MODE: '1',
      ADMIN_STEAMIDS: '76561198000000001,76561198000000002',
    });
    expect(c.port).toBe(9000);
    expect(c.devMode).toBe(true);
    expect(c.adminSteamIds).toEqual(['76561198000000001', '76561198000000002']);
  });
});

describe('campaigns', () => {
  it('has the four original campaigns', () => {
    expect(Object.keys(CAMPAIGNS)).toEqual(['no_mercy', 'death_toll', 'dead_air', 'blood_harvest']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — cannot find module `../src/config.js`.

- [ ] **Step 3: Write `src/config.ts`**

```ts
export interface Config {
  port: number;
  publicUrl: string;
  dbPath: string;
  cookieSecret: string;
  adminSteamIds: string[];
  devMode: boolean;
  steamApiKey: string | null;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return {
    port: Number(env.PORT ?? 8080),
    publicUrl: env.PUBLIC_URL ?? 'http://localhost:8080',
    dbPath: env.DB_PATH ?? 'data/pug.db',
    cookieSecret: env.COOKIE_SECRET ?? 'dev-secret-change-me',
    adminSteamIds: (env.ADMIN_STEAMIDS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    devMode: env.DEV_MODE === '1',
    steamApiKey: env.STEAM_API_KEY ?? null,
  };
}
```

- [ ] **Step 4: Write `src/campaigns.ts`**

```ts
export const CAMPAIGNS: Record<string, { name: string }> = {
  no_mercy: { name: 'No Mercy' },
  death_toll: { name: 'Death Toll' },
  dead_air: { name: 'Dead Air' },
  blood_harvest: { name: 'Blood Harvest' },
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: config loader and campaign constants"
```

---

### Task 3: Database schema, seed, and settings

**Files:**
- Create: `src/db.ts`, `src/settings.ts`
- Test: `tests/db.test.ts`

- [ ] **Step 1: Write failing test `tests/db.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { getSetting, setSetting, getJsonSetting } from '../src/settings.js';

describe('openDb', () => {
  it('creates all tables', () => {
    const db = openDb(':memory:');
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((r: any) => r.name);
    expect(names).toEqual([
      'match_players', 'matches', 'player_ratings', 'players',
      'rating_history', 'seasons', 'servers', 'settings',
    ]);
  });

  it('seeds season 1 and default settings, idempotently', () => {
    const db = openDb(':memory:');
    const seasons = db.prepare('SELECT * FROM seasons').all();
    expect(seasons).toHaveLength(1);
    expect(getSetting(db, 'invite_code')).toBe('change-me');
    expect(getSetting(db, 'ready_seconds')).toBe('60');
    expect(getSetting(db, 'vote_seconds')).toBe('30');
    expect(getJsonSetting<string[]>(db, 'map_pool')).toEqual([
      'no_mercy', 'death_toll', 'dead_air', 'blood_harvest',
    ]);
  });

  it('settings set/get roundtrip', () => {
    const db = openDb(':memory:');
    setSetting(db, 'invite_code', 'sekrit');
    expect(getSetting(db, 'invite_code')).toBe('sekrit');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db.test.ts`
Expected: FAIL — cannot find module `../src/db.js`.

- [ ] **Step 3: Write `src/db.ts`**

```ts
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS players (
  steamid TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  avatar TEXT,
  status TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','active','banned')),
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS seasons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT
);
CREATE TABLE IF NOT EXISTS player_ratings (
  player_id TEXT NOT NULL REFERENCES players(steamid),
  season_id INTEGER NOT NULL REFERENCES seasons(id),
  mu REAL NOT NULL,
  sigma REAL NOT NULL,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (player_id, season_id)
);
CREATE TABLE IF NOT EXISTS servers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  rcon_port INTEGER NOT NULL,
  rcon_password TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('idle','reserved','live','offline'))
);
CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id INTEGER NOT NULL REFERENCES seasons(id),
  state TEXT NOT NULL CHECK (state IN ('configuring','live','completed','aborted')),
  campaign TEXT NOT NULL,
  server_id INTEGER REFERENCES servers(id),
  team_a_score INTEGER NOT NULL DEFAULT 0,
  team_b_score INTEGER NOT NULL DEFAULT 0,
  winner TEXT CHECK (winner IN ('a','b','draw')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT
);
CREATE TABLE IF NOT EXISTS match_players (
  match_id INTEGER NOT NULL REFERENCES matches(id),
  player_id TEXT NOT NULL REFERENCES players(steamid),
  team TEXT NOT NULL CHECK (team IN ('a','b')),
  si_damage INTEGER NOT NULL DEFAULT 0,
  si_kills INTEGER NOT NULL DEFAULT 0,
  common_kills INTEGER NOT NULL DEFAULT 0,
  ff_dealt INTEGER NOT NULL DEFAULT 0,
  revives INTEGER NOT NULL DEFAULT 0,
  stats_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (match_id, player_id)
);
CREATE TABLE IF NOT EXISTS rating_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id TEXT NOT NULL,
  match_id INTEGER NOT NULL,
  season_id INTEGER NOT NULL,
  mu_before REAL NOT NULL,
  sigma_before REAL NOT NULL,
  mu_after REAL NOT NULL,
  sigma_after REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const DEFAULT_SETTINGS: Record<string, string> = {
  invite_code: 'change-me',
  ready_seconds: '60',
  vote_seconds: '30',
  map_pool: JSON.stringify(['no_mercy', 'death_toll', 'dead_air', 'blood_harvest']),
};

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  seed(db);
  return db;
}

function seed(db: DB): void {
  const seasonCount = db.prepare('SELECT COUNT(*) AS n FROM seasons').get() as { n: number };
  if (seasonCount.n === 0) {
    db.prepare('INSERT INTO seasons (name) VALUES (?)').run('Season 1');
  }
  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) insert.run(key, value);
}
```

- [ ] **Step 4: Write `src/settings.ts`**

```ts
import type { DB } from './db.js';

export function getSetting(db: DB, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setSetting(db: DB, key: string, value: string): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

export function getJsonSetting<T>(db: DB, key: string): T {
  const raw = getSetting(db, key);
  if (raw === undefined) throw new Error(`missing setting: ${key}`);
  return JSON.parse(raw) as T;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/db.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: sqlite schema, seed, settings helpers"
```

---

### Task 4: Player repository

**Files:**
- Create: `src/players.ts`
- Test: `tests/players.test.ts`

- [ ] **Step 1: Write failing test `tests/players.test.ts`**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import {
  upsertPlayer, getPlayer, activatePlayer, currentSeasonId, ensureRating, getRatings,
} from '../src/players.js';

const P1 = '76561198000000001';
const ADMIN = '76561198000000009';

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
});

describe('upsertPlayer', () => {
  it('creates new players as invited', () => {
    upsertPlayer(db, { steamid: P1, name: 'alice', avatar: null }, []);
    const p = getPlayer(db, P1)!;
    expect(p.status).toBe('invited');
    expect(p.is_admin).toBe(0);
    expect(p.name).toBe('alice');
  });

  it('creates admins as active with admin flag', () => {
    upsertPlayer(db, { steamid: ADMIN, name: 'boss', avatar: null }, [ADMIN]);
    const p = getPlayer(db, ADMIN)!;
    expect(p.status).toBe('active');
    expect(p.is_admin).toBe(1);
  });

  it('updates name/avatar on re-login without touching status', () => {
    upsertPlayer(db, { steamid: P1, name: 'alice', avatar: null }, []);
    activatePlayer(db, P1);
    upsertPlayer(db, { steamid: P1, name: 'alice2', avatar: 'x.jpg' }, []);
    const p = getPlayer(db, P1)!;
    expect(p.name).toBe('alice2');
    expect(p.avatar).toBe('x.jpg');
    expect(p.status).toBe('active');
  });
});

describe('ratings', () => {
  it('ensureRating creates default openskill rating for current season', () => {
    upsertPlayer(db, { steamid: P1, name: 'alice', avatar: null }, []);
    const r = ensureRating(db, P1);
    expect(r.season_id).toBe(currentSeasonId(db));
    expect(r.mu).toBeCloseTo(25);
    expect(r.sigma).toBeCloseTo(25 / 3);
    expect(ensureRating(db, P1)).toEqual(r); // idempotent
  });

  it('getRatings returns a map for multiple players', () => {
    upsertPlayer(db, { steamid: P1, name: 'a', avatar: null }, []);
    upsertPlayer(db, { steamid: ADMIN, name: 'b', avatar: null }, []);
    ensureRating(db, P1);
    ensureRating(db, ADMIN);
    const m = getRatings(db, [P1, ADMIN]);
    expect(m.size).toBe(2);
    expect(m.get(P1)!.mu).toBeCloseTo(25);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/players.test.ts`
Expected: FAIL — cannot find module `../src/players.js`.

- [ ] **Step 3: Write `src/players.ts`**

```ts
import { rating } from 'openskill';
import type { DB } from './db.js';

export interface PlayerRow {
  steamid: string;
  name: string;
  avatar: string | null;
  status: 'invited' | 'active' | 'banned';
  is_admin: number;
  created_at: string;
}

export interface RatingRow {
  player_id: string;
  season_id: number;
  mu: number;
  sigma: number;
  wins: number;
  losses: number;
}

export function upsertPlayer(
  db: DB,
  p: { steamid: string; name: string; avatar: string | null },
  adminSteamIds: string[],
): void {
  const isAdmin = adminSteamIds.includes(p.steamid);
  db.prepare(
    `INSERT INTO players (steamid, name, avatar, status, is_admin)
     VALUES (@steamid, @name, @avatar, @status, @is_admin)
     ON CONFLICT(steamid) DO UPDATE SET name = excluded.name, avatar = excluded.avatar`,
  ).run({
    steamid: p.steamid,
    name: p.name,
    avatar: p.avatar,
    status: isAdmin ? 'active' : 'invited',
    is_admin: isAdmin ? 1 : 0,
  });
}

export function getPlayer(db: DB, steamid: string): PlayerRow | undefined {
  return db.prepare('SELECT * FROM players WHERE steamid = ?').get(steamid) as PlayerRow | undefined;
}

export function activatePlayer(db: DB, steamid: string): void {
  db.prepare("UPDATE players SET status = 'active' WHERE steamid = ?").run(steamid);
}

export function currentSeasonId(db: DB): number {
  const row = db.prepare('SELECT id FROM seasons WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1').get() as { id: number };
  return row.id;
}

export function ensureRating(db: DB, steamid: string): RatingRow {
  const season = currentSeasonId(db);
  const existing = db
    .prepare('SELECT * FROM player_ratings WHERE player_id = ? AND season_id = ?')
    .get(steamid, season) as RatingRow | undefined;
  if (existing) return existing;
  const r = rating(); // openskill defaults: mu=25, sigma=25/3
  db.prepare(
    'INSERT INTO player_ratings (player_id, season_id, mu, sigma) VALUES (?, ?, ?, ?)',
  ).run(steamid, season, r.mu, r.sigma);
  return { player_id: steamid, season_id: season, mu: r.mu, sigma: r.sigma, wins: 0, losses: 0 };
}

export function getRatings(db: DB, steamids: string[]): Map<string, RatingRow> {
  const out = new Map<string, RatingRow>();
  for (const id of steamids) out.set(id, ensureRating(db, id));
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/players.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: player repository with season-aware ratings"
```

---

### Task 5: Steam OpenID module

**Files:**
- Create: `src/steamAuth.ts`
- Test: `tests/steamAuth.test.ts`

Background for the implementer: Steam login uses OpenID 2.0 (not OIDC). Flow: redirect the browser to `https://steamcommunity.com/openid/login` with `checkid_setup` params; Steam redirects back to `return_to` with signed query params; the server verifies them by POSTing the same params back with `openid.mode=check_authentication`; Steam answers a text body containing `is_valid:true`. The SteamID64 is embedded in `openid.claimed_id`.

- [ ] **Step 1: Write failing test `tests/steamAuth.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { loginUrl, verifyLogin } from '../src/steamAuth.js';

const VALID_QUERY: Record<string, string> = {
  'openid.ns': 'http://specs.openid.net/auth/2.0',
  'openid.mode': 'id_res',
  'openid.claimed_id': 'https://steamcommunity.com/openid/id/76561198000000001',
  'openid.identity': 'https://steamcommunity.com/openid/id/76561198000000001',
  'openid.sig': 'abc',
  'openid.signed': 'signed,op_endpoint,claimed_id',
};

function fakeFetch(body: string) {
  return async () => new Response(body, { status: 200 });
}

describe('loginUrl', () => {
  it('builds a checkid_setup redirect to steam', () => {
    const url = new URL(loginUrl('http://localhost:8080'));
    expect(url.origin + url.pathname).toBe('https://steamcommunity.com/openid/login');
    expect(url.searchParams.get('openid.mode')).toBe('checkid_setup');
    expect(url.searchParams.get('openid.return_to')).toBe('http://localhost:8080/auth/steam/return');
    expect(url.searchParams.get('openid.realm')).toBe('http://localhost:8080');
  });
});

describe('verifyLogin', () => {
  it('returns steamid64 when steam says is_valid:true', async () => {
    const id = await verifyLogin(VALID_QUERY, fakeFetch('ns:http://specs.openid.net/auth/2.0\nis_valid:true\n'));
    expect(id).toBe('76561198000000001');
  });

  it('returns null when steam says is_valid:false', async () => {
    const id = await verifyLogin(VALID_QUERY, fakeFetch('is_valid:false\n'));
    expect(id).toBeNull();
  });

  it('returns null for a malformed claimed_id even if valid', async () => {
    const q = { ...VALID_QUERY, 'openid.claimed_id': 'https://evil.example/openid/id/123' };
    const id = await verifyLogin(q, fakeFetch('is_valid:true\n'));
    expect(id).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/steamAuth.test.ts`
Expected: FAIL — cannot find module `../src/steamAuth.js`.

- [ ] **Step 3: Write `src/steamAuth.ts`**

```ts
const STEAM_OPENID_URL = 'https://steamcommunity.com/openid/login';
const CLAIMED_ID_RE = /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/;

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export function loginUrl(publicUrl: string): string {
  const params = new URLSearchParams({
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'checkid_setup',
    'openid.return_to': `${publicUrl}/auth/steam/return`,
    'openid.realm': publicUrl,
    'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
    'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
  });
  return `${STEAM_OPENID_URL}?${params}`;
}

export async function verifyLogin(
  query: Record<string, string>,
  fetchFn: FetchFn = fetch,
): Promise<string | null> {
  const match = CLAIMED_ID_RE.exec(query['openid.claimed_id'] ?? '');
  if (!match) return null;

  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (k.startsWith('openid.')) params.set(k, v);
  }
  params.set('openid.mode', 'check_authentication');

  const res = await fetchFn(STEAM_OPENID_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const body = await res.text();
  if (!body.includes('is_valid:true')) return null;
  return match[1];
}

/** Best-effort persona lookup; falls back to the steamid as display name. */
export async function fetchPersona(
  steamid: string,
  apiKey: string | null,
  fetchFn: FetchFn = fetch,
): Promise<{ name: string; avatar: string | null }> {
  if (!apiKey) return { name: steamid, avatar: null };
  try {
    const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${apiKey}&steamids=${steamid}`;
    const res = await fetchFn(url);
    const data: any = await res.json();
    const p = data?.response?.players?.[0];
    if (!p) return { name: steamid, avatar: null };
    return { name: p.personaname ?? steamid, avatar: p.avatarfull ?? null };
  } catch {
    return { name: steamid, avatar: null };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/steamAuth.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: steam openid login/verify module"
```

---

### Task 6: HTTP server base, sessions, auth routes

**Files:**
- Create: `src/session.ts`, `src/server.ts`, `src/routes/auth.ts`, `src/index.ts`
- Test: `tests/auth.test.ts`

- [ ] **Step 1: Write `src/session.ts`**

```ts
import type { FastifyReply, FastifyRequest } from 'fastify';

export const SESSION_COOKIE = 'pug_session';

export function setSession(reply: FastifyReply, steamid: string): void {
  reply.setCookie(SESSION_COOKIE, steamid, {
    path: '/',
    httpOnly: true,
    signed: true,
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 30,
  });
}

export function getSession(req: FastifyRequest): string | null {
  const raw = req.cookies[SESSION_COOKIE];
  if (!raw) return null;
  const unsigned = req.unsignCookie(raw);
  return unsigned.valid && unsigned.value ? unsigned.value : null;
}
```

- [ ] **Step 2: Write `src/server.ts`**

The `verifyLogin` dependency is injectable so tests can fake Steam. More route files register here in Tasks 10, 12, 13 — the `deps` object grows then too.

```ts
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Config } from './config.js';
import type { DB } from './db.js';
import { verifyLogin as realVerifyLogin, fetchPersona as realFetchPersona } from './steamAuth.js';
import { authRoutes } from './routes/auth.js';

export interface ServerDeps {
  config: Config;
  db: DB;
  verifyLogin?: typeof realVerifyLogin;
  fetchPersona?: typeof realFetchPersona;
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cookie, { secret: deps.config.cookieSecret });
  await app.register(websocket);
  await app.register(fastifyStatic, {
    root: join(dirname(fileURLToPath(import.meta.url)), '..', 'public'),
  });

  await app.register(authRoutes, {
    config: deps.config,
    db: deps.db,
    verifyLogin: deps.verifyLogin ?? realVerifyLogin,
    fetchPersona: deps.fetchPersona ?? realFetchPersona,
  });

  return app;
}
```

- [ ] **Step 3: Write `src/routes/auth.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import type { DB } from '../db.js';
import type { verifyLogin as VerifyFn, fetchPersona as PersonaFn } from '../steamAuth.js';
import { loginUrl } from '../steamAuth.js';
import { getSession, setSession } from '../session.js';
import { activatePlayer, getPlayer, upsertPlayer } from '../players.js';
import { getSetting } from '../settings.js';

export interface AuthRouteOpts {
  config: Config;
  db: DB;
  verifyLogin: typeof VerifyFn;
  fetchPersona: typeof PersonaFn;
}

export async function authRoutes(app: FastifyInstance, opts: AuthRouteOpts): Promise<void> {
  const { config, db } = opts;

  app.get('/auth/steam', async (_req, reply) => {
    return reply.redirect(loginUrl(config.publicUrl));
  });

  app.get('/auth/steam/return', async (req, reply) => {
    const steamid = await opts.verifyLogin(req.query as Record<string, string>);
    if (!steamid) return reply.code(403).send('Steam login failed');
    const persona = await opts.fetchPersona(steamid, config.steamApiKey);
    upsertPlayer(db, { steamid, name: persona.name, avatar: persona.avatar }, config.adminSteamIds);
    setSession(reply, steamid);
    return reply.redirect('/');
  });

  app.get('/api/me', async (req, reply) => {
    const steamid = getSession(req);
    if (!steamid) return reply.code(401).send({ error: 'not logged in' });
    const player = getPlayer(db, steamid);
    if (!player) return reply.code(401).send({ error: 'unknown player' });
    return {
      steamid: player.steamid,
      name: player.name,
      avatar: player.avatar,
      status: player.status,
      isAdmin: player.is_admin === 1,
    };
  });

  app.post('/api/register', async (req, reply) => {
    const steamid = getSession(req);
    if (!steamid) return reply.code(401).send({ error: 'not logged in' });
    const player = getPlayer(db, steamid);
    if (!player) return reply.code(401).send({ error: 'unknown player' });
    if (player.status === 'banned') return reply.code(403).send({ error: 'banned' });
    if (player.status === 'active') return { ok: true };
    const { code } = (req.body ?? {}) as { code?: string };
    if (!code || code !== getSetting(db, 'invite_code')) {
      return reply.code(403).send({ error: 'bad invite code' });
    }
    activatePlayer(db, steamid);
    return { ok: true };
  });
}
```

- [ ] **Step 4: Write `src/index.ts`**

```ts
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { buildServer } from './server.js';

const config = loadConfig();
const db = openDb(config.dbPath);
const app = await buildServer({ config, db });

await app.listen({ port: config.port, host: '0.0.0.0' });
console.log(`pug-web listening on :${config.port} (devMode=${config.devMode})`);
```

- [ ] **Step 5: Write failing test `tests/auth.test.ts`**

The helper `authedCookie` is reused by later test files — export it from a shared helper file.

Create `tests/helpers.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import type { DB } from '../src/db.js';
import { upsertPlayer, activatePlayer } from '../src/players.js';
import { SESSION_COOKIE } from '../src/session.js';

export function authedCookie(
  app: FastifyInstance,
  db: DB,
  steamid: string,
  opts: { active?: boolean } = {},
): Record<string, string> {
  upsertPlayer(db, { steamid, name: `p${steamid.slice(-3)}`, avatar: null }, []);
  if (opts.active !== false) activatePlayer(db, steamid);
  return { [SESSION_COOKIE]: app.signCookie(steamid) };
}
```

Create `tests/auth.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { setSetting } from '../src/settings.js';
import { getPlayer } from '../src/players.js';
import { authedCookie } from './helpers.js';

const P1 = '76561198000000001';

let db: DB;
let app: FastifyInstance;

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({
    config: loadConfig({}),
    db,
    verifyLogin: async () => P1,
    fetchPersona: async (steamid) => ({ name: 'alice', avatar: null }),
  });
});

describe('auth', () => {
  it('GET /auth/steam redirects to steam openid', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/steam' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('steamcommunity.com/openid/login');
  });

  it('GET /auth/steam/return creates player, sets cookie, redirects home', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/steam/return?openid.mode=id_res' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/');
    expect(res.cookies.find((c) => c.name === 'pug_session')).toBeTruthy();
    expect(getPlayer(db, P1)!.name).toBe('alice');
  });

  it('GET /api/me returns 401 without session, player with session', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/me' })).statusCode).toBe(401);
    const res = await app.inject({
      method: 'GET', url: '/api/me',
      cookies: authedCookie(app, db, P1, { active: false }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('invited');
  });

  it('POST /api/register activates with correct invite code, rejects wrong', async () => {
    setSetting(db, 'invite_code', 'sekrit');
    const cookies = authedCookie(app, db, P1, { active: false });
    const bad = await app.inject({
      method: 'POST', url: '/api/register', cookies, payload: { code: 'nope' },
    });
    expect(bad.statusCode).toBe(403);
    const good = await app.inject({
      method: 'POST', url: '/api/register', cookies, payload: { code: 'sekrit' },
    });
    expect(good.statusCode).toBe(200);
    expect(getPlayer(db, P1)!.status).toBe('active');
  });
});
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run tests/auth.test.ts && npx tsc --noEmit`
Expected: PASS (4 tests), clean typecheck. (An empty `public/` dir is fine for @fastify/static — if it errors on a missing dir, `mkdir -p public` and add `public/.gitkeep`.)

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: fastify server, sessions, steam auth routes, invite gate"
```

---

### Task 7: Queue

**Files:**
- Create: `src/queue.ts`
- Test: `tests/queue.test.ts`

- [ ] **Step 1: Write failing test `tests/queue.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { Queue } from '../src/queue.js';

describe('Queue', () => {
  it('joins are ordered and idempotent', () => {
    const q = new Queue();
    q.join('a'); q.join('b'); q.join('a');
    expect(q.count()).toBe(2);
    expect(q.list()).toEqual(['a', 'b']);
    expect(q.has('a')).toBe(true);
  });

  it('leave removes', () => {
    const q = new Queue();
    q.join('a'); q.join('b'); q.leave('a');
    expect(q.list()).toEqual(['b']);
  });

  it('takeBatch pops the first n in order', () => {
    const q = new Queue();
    for (const id of ['a', 'b', 'c']) q.join(id);
    expect(q.takeBatch(2)).toEqual(['a', 'b']);
    expect(q.list()).toEqual(['c']);
  });

  it('requeueFront puts players ahead of existing queue', () => {
    const q = new Queue();
    q.join('x');
    q.requeueFront(['a', 'b']);
    expect(q.list()).toEqual(['a', 'b', 'x']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/queue.test.ts`
Expected: FAIL — cannot find module `../src/queue.js`.

- [ ] **Step 3: Write `src/queue.ts`**

```ts
export const QUEUE_SIZE = 8;

export class Queue {
  private order: string[] = [];

  join(steamid: string): void {
    if (!this.order.includes(steamid)) this.order.push(steamid);
  }

  leave(steamid: string): void {
    this.order = this.order.filter((id) => id !== steamid);
  }

  has(steamid: string): boolean {
    return this.order.includes(steamid);
  }

  count(): number {
    return this.order.length;
  }

  list(): string[] {
    return [...this.order];
  }

  takeBatch(n: number): string[] {
    return this.order.splice(0, n);
  }

  requeueFront(steamids: string[]): void {
    this.order = [...steamids.filter((id) => !this.order.includes(id)), ...this.order];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/queue.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: ordered queue"
```

---

### Task 8: Lobby state machine (ready check + map vote)

**Files:**
- Create: `src/lobby.ts`
- Test: `tests/lobby.test.ts`

Design: a `Lobby` runs two timed phases. Timers go through an injectable scheduler so tests control time. Randomness goes through an injectable `rng` (`() => number` in [0,1)).

- Phase `ready_check`: all 8 must `markReady` within `readySeconds`, else `onFail(ready, notReady)`.
- Phase `map_vote`: each player may `castVote` (re-voting replaces). Ends early when all 8 voted, else at `voteSeconds`. Tally: plurality; ties broken by rng; zero votes → rng pick from pool. Then `onComplete({ players, campaign })`.

- [ ] **Step 1: Write failing test `tests/lobby.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { Lobby, type LobbyEvents, type Scheduler } from '../src/lobby.js';

const PLAYERS = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'];
const POOL = ['no_mercy', 'death_toll', 'dead_air', 'blood_harvest'];

class FakeScheduler implements Scheduler {
  timers = new Map<number, () => void>();
  private nextId = 1;
  set(fn: () => void, _ms: number): number {
    const id = this.nextId++;
    this.timers.set(id, fn);
    return id;
  }
  clear(id: number): void {
    this.timers.delete(id);
  }
  fireAll(): void {
    const fns = [...this.timers.values()];
    this.timers.clear();
    fns.forEach((fn) => fn());
  }
}

function makeLobby(overrides: Partial<LobbyEvents> = {}, rng: () => number = () => 0) {
  const events: LobbyEvents & { completed: any[]; failed: any[] } = {
    completed: [], failed: [],
    onEvent: () => {},
    onComplete: (r) => events.completed.push(r),
    onFail: (ready, notReady) => events.failed.push({ ready, notReady }),
    ...overrides,
  };
  const sched = new FakeScheduler();
  const lobby = new Lobby('lob_1', PLAYERS, { readySeconds: 60, voteSeconds: 30, mapPool: POOL, rng }, events, sched);
  return { lobby, events, sched };
}

describe('ready check', () => {
  it('advances to map_vote when all 8 ready', () => {
    const { lobby } = makeLobby();
    for (const p of PLAYERS) lobby.markReady(p);
    expect(lobby.snapshot().phase).toBe('map_vote');
  });

  it('fails with ready/notReady split when timer fires', () => {
    const { lobby, events, sched } = makeLobby();
    lobby.markReady('p1');
    lobby.markReady('p2');
    sched.fireAll();
    expect(events.failed).toEqual([{ ready: ['p1', 'p2'], notReady: ['p3', 'p4', 'p5', 'p6', 'p7', 'p8'] }]);
    expect(lobby.snapshot().phase).toBe('failed');
  });

  it('rejects ready from non-members', () => {
    const { lobby } = makeLobby();
    expect(lobby.markReady('stranger')).toBe(false);
  });
});

describe('map vote', () => {
  function toVote() {
    const made = makeLobby();
    for (const p of PLAYERS) made.lobby.markReady(p);
    return made;
  }

  it('tallies plurality when all vote', () => {
    const { lobby, events } = toVote();
    for (const p of PLAYERS.slice(0, 5)) lobby.castVote(p, 'dead_air');
    for (const p of PLAYERS.slice(5)) lobby.castVote(p, 'no_mercy');
    expect(events.completed).toEqual([{ players: PLAYERS, campaign: 'dead_air' }]);
    expect(lobby.snapshot().phase).toBe('done');
  });

  it('tallies on timer with partial votes; zero votes -> rng pick', () => {
    const { lobby, events, sched } = toVote();
    sched.fireAll(); // vote timer fires, nobody voted; rng()=0 -> first in pool
    expect(events.completed[0].campaign).toBe('no_mercy');
    expect(lobby.snapshot().phase).toBe('done');
  });

  it('rejects votes for campaigns not in the pool', () => {
    const { lobby } = toVote();
    expect(lobby.castVote('p1', 'crash_course')).toBe(false);
  });

  it('re-voting replaces the previous vote', () => {
    const { lobby, events, sched } = toVote();
    lobby.castVote('p1', 'no_mercy');
    lobby.castVote('p1', 'dead_air');
    sched.fireAll();
    expect(events.completed[0].campaign).toBe('dead_air');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lobby.test.ts`
Expected: FAIL — cannot find module `../src/lobby.js`.

- [ ] **Step 3: Write `src/lobby.ts`**

```ts
export type LobbyPhase = 'ready_check' | 'map_vote' | 'done' | 'failed';

export interface Scheduler {
  set(fn: () => void, ms: number): number;
  clear(id: number): void;
}

export const realScheduler: Scheduler = {
  set: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  clear: (id) => clearTimeout(id as unknown as NodeJS.Timeout),
};

export interface LobbyOpts {
  readySeconds: number;
  voteSeconds: number;
  mapPool: string[];
  rng?: () => number;
}

export interface LobbyEvents {
  /** Fired on any state change worth broadcasting. */
  onEvent(): void;
  onComplete(result: { players: string[]; campaign: string }): void;
  onFail(ready: string[], notReady: string[]): void;
}

export interface LobbySnapshot {
  id: string;
  phase: LobbyPhase;
  players: string[];
  ready: string[];
  options: string[];
  votes: Record<string, number>;
  deadline: number;
}

export class Lobby {
  readonly id: string;
  readonly players: string[];
  private phase: LobbyPhase = 'ready_check';
  private ready = new Set<string>();
  private votes = new Map<string, string>();
  private timer: number | null = null;
  private deadline = 0;
  private readonly rng: () => number;

  constructor(
    id: string,
    players: string[],
    private opts: LobbyOpts,
    private events: LobbyEvents,
    private sched: Scheduler = realScheduler,
  ) {
    this.id = id;
    this.players = [...players];
    this.rng = opts.rng ?? Math.random;
    this.startTimer(opts.readySeconds, () => this.failReadyCheck());
  }

  private startTimer(seconds: number, onFire: () => void): void {
    if (this.timer !== null) this.sched.clear(this.timer);
    this.deadline = Date.now() + seconds * 1000;
    this.timer = this.sched.set(onFire, seconds * 1000);
  }

  private stopTimer(): void {
    if (this.timer !== null) this.sched.clear(this.timer);
    this.timer = null;
  }

  markReady(steamid: string): boolean {
    if (this.phase !== 'ready_check' || !this.players.includes(steamid)) return false;
    this.ready.add(steamid);
    if (this.ready.size === this.players.length) {
      this.phase = 'map_vote';
      this.startTimer(this.opts.voteSeconds, () => this.tally());
    }
    this.events.onEvent();
    return true;
  }

  castVote(steamid: string, campaign: string): boolean {
    if (this.phase !== 'map_vote' || !this.players.includes(steamid)) return false;
    if (!this.opts.mapPool.includes(campaign)) return false;
    this.votes.set(steamid, campaign);
    if (this.votes.size === this.players.length) {
      this.tally();
    } else {
      this.events.onEvent();
    }
    return true;
  }

  private failReadyCheck(): void {
    if (this.phase !== 'ready_check') return;
    this.stopTimer();
    this.phase = 'failed';
    const ready = this.players.filter((p) => this.ready.has(p));
    const notReady = this.players.filter((p) => !this.ready.has(p));
    this.events.onFail(ready, notReady);
  }

  private tally(): void {
    if (this.phase !== 'map_vote') return;
    this.stopTimer();
    const counts = new Map<string, number>();
    for (const c of this.votes.values()) counts.set(c, (counts.get(c) ?? 0) + 1);
    let winners: string[];
    if (counts.size === 0) {
      winners = [...this.opts.mapPool];
    } else {
      const max = Math.max(...counts.values());
      winners = [...counts.entries()].filter(([, n]) => n === max).map(([c]) => c);
    }
    const campaign = winners[Math.floor(this.rng() * winners.length)];
    this.phase = 'done';
    this.events.onComplete({ players: this.players, campaign });
  }

  snapshot(): LobbySnapshot {
    const votes: Record<string, number> = {};
    for (const c of this.votes.values()) votes[c] = (votes[c] ?? 0) + 1;
    return {
      id: this.id,
      phase: this.phase,
      players: [...this.players],
      ready: [...this.ready],
      options: [...this.opts.mapPool],
      votes,
      deadline: this.deadline,
    };
  }

  myVote(steamid: string): string | null {
    return this.votes.get(steamid) ?? null;
  }

  destroy(): void {
    this.stopTimer();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/lobby.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: lobby state machine (ready check + map vote)"
```

---

### Task 9: Team balancer

**Files:**
- Create: `src/balance.ts`
- Test: `tests/balance.test.ts`

Design: player 0 is fixed on team A (halves the search space); enumerate all C(7,3)=35 ways to pick their 3 teammates; score each split with openskill `predictWin`; keep the split closest to 50/50.

- [ ] **Step 1: Write failing test `tests/balance.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { balanceTeams, type RatedPlayer } from '../src/balance.js';

function p(steamid: string, mu: number, sigma = 25 / 3): RatedPlayer {
  return { steamid, mu, sigma };
}

describe('balanceTeams', () => {
  it('splits 8 into 4v4 with near-even odds for equal players', () => {
    const players = Array.from({ length: 8 }, (_, i) => p(`p${i}`, 25));
    const { teamA, teamB, pWinA } = balanceTeams(players);
    expect(teamA).toHaveLength(4);
    expect(teamB).toHaveLength(4);
    expect([...teamA, ...teamB].sort()).toEqual(players.map((x) => x.steamid).sort());
    expect(pWinA).toBeCloseTo(0.5, 1);
  });

  it('separates the two strongest players', () => {
    const players = [p('star1', 40), p('star2', 40), ...Array.from({ length: 6 }, (_, i) => p(`p${i}`, 25))];
    const { teamA, teamB } = balanceTeams(players);
    const aHasStar1 = teamA.includes('star1');
    expect(aHasStar1 ? teamB : teamA).toContain('star2');
  });

  it('produces odds closer to even than a naive first-4/last-4 split', () => {
    const players = [p('a', 35), p('b', 33), p('c', 31), p('d', 29), p('e', 24), p('f', 22), p('g', 20), p('h', 18)];
    const { pWinA } = balanceTeams(players);
    expect(Math.abs(pWinA - 0.5)).toBeLessThan(0.1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/balance.test.ts`
Expected: FAIL — cannot find module `../src/balance.js`.

- [ ] **Step 3: Write `src/balance.ts`**

```ts
import { rating, predictWin } from 'openskill';

export interface RatedPlayer {
  steamid: string;
  mu: number;
  sigma: number;
}

export interface BalanceResult {
  teamA: string[];
  teamB: string[];
  pWinA: number;
}

export function balanceTeams(players: RatedPlayer[]): BalanceResult {
  if (players.length !== 8) throw new Error(`balanceTeams needs exactly 8 players, got ${players.length}`);
  const ratings = players.map((p) => rating({ mu: p.mu, sigma: p.sigma }));

  let best: BalanceResult | null = null;
  // player 0 always on team A; choose 3 teammates from indices 1..7
  for (let i = 1; i <= 5; i++) {
    for (let j = i + 1; j <= 6; j++) {
      for (let k = j + 1; k <= 7; k++) {
        const aIdx = [0, i, j, k];
        const bIdx = [1, 2, 3, 4, 5, 6, 7].filter((x) => !aIdx.includes(x));
        const [pA] = predictWin([aIdx.map((x) => ratings[x]), bIdx.map((x) => ratings[x])]);
        if (!best || Math.abs(pA - 0.5) < Math.abs(best.pWinA - 0.5)) {
          best = {
            teamA: aIdx.map((x) => players[x].steamid),
            teamB: bIdx.map((x) => players[x].steamid),
            pWinA: pA,
          };
        }
      }
    }
  }
  return best!;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/balance.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: openskill team balancer (35-split exhaustive search)"
```

---

### Task 10: Websocket hub and /ws route

**Files:**
- Create: `src/ws.ts`, `src/routes/ws.ts`
- Modify: `src/server.ts` (register the route)
- Test: `tests/ws.test.ts`

- [ ] **Step 1: Write failing test `tests/ws.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { Hub } from '../src/ws.js';

function fakeSocket() {
  const sent: string[] = [];
  return { sent, readyState: 1, send: (msg: string) => sent.push(msg) };
}

describe('Hub', () => {
  it('broadcasts to all open sockets', () => {
    const hub = new Hub();
    const s1 = fakeSocket();
    const s2 = fakeSocket();
    hub.add(s1 as any);
    hub.add(s2 as any);
    hub.broadcast('refresh');
    expect(s1.sent).toEqual(['{"event":"refresh"}']);
    expect(s2.sent).toEqual(['{"event":"refresh"}']);
  });

  it('skips closed sockets and removed sockets', () => {
    const hub = new Hub();
    const open = fakeSocket();
    const closed = { ...fakeSocket(), readyState: 3 };
    const removed = fakeSocket();
    hub.add(open as any);
    hub.add(closed as any);
    hub.add(removed as any);
    hub.remove(removed as any);
    hub.broadcast('refresh');
    expect(open.sent).toHaveLength(1);
    expect(closed.sent).toHaveLength(0);
    expect(removed.sent).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ws.test.ts`
Expected: FAIL — cannot find module `../src/ws.js`.

- [ ] **Step 3: Write `src/ws.ts`**

```ts
interface SocketLike {
  readyState: number;
  send(data: string): void;
}

const OPEN = 1;

export class Hub {
  private sockets = new Set<SocketLike>();

  add(socket: SocketLike): void {
    this.sockets.add(socket);
  }

  remove(socket: SocketLike): void {
    this.sockets.delete(socket);
  }

  broadcast(event: string): void {
    const msg = JSON.stringify({ event });
    for (const s of this.sockets) {
      if (s.readyState === OPEN) s.send(msg);
    }
  }
}
```

- [ ] **Step 4: Write `src/routes/ws.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import type { Hub } from '../ws.js';

export async function wsRoutes(app: FastifyInstance, opts: { hub: Hub }): Promise<void> {
  app.get('/ws', { websocket: true }, (socket) => {
    opts.hub.add(socket);
    socket.on('close', () => opts.hub.remove(socket));
  });
}
```

- [ ] **Step 5: Modify `src/server.ts` — create the hub and register the route**

Add imports at the top:

```ts
import { Hub } from './ws.js';
import { wsRoutes } from './routes/ws.js';
```

Inside `buildServer`, after the auth route registration, add (and expose the hub on the returned deps — later tasks need it):

```ts
  const hub = deps.hub ?? new Hub();
  await app.register(wsRoutes, { hub });
```

And extend `ServerDeps`:

```ts
export interface ServerDeps {
  config: Config;
  db: DB;
  verifyLogin?: typeof realVerifyLogin;
  fetchPersona?: typeof realFetchPersona;
  hub?: Hub;
}
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all tests pass, clean typecheck.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: websocket hub with refresh broadcasts"
```

---

### Task 11: Matchmaker service and orchestrator stub

**Files:**
- Create: `src/orchestrator.ts`, `src/matchmaker.ts`
- Test: `tests/matchmaker.test.ts`

Design: `Matchmaker` owns the `Queue` and all live `Lobby` instances. Whenever the queue reaches 8, it pops a batch into a new lobby. On lobby completion it balances teams, writes the `matches` + `match_players` rows (state `configuring`), and calls the orchestrator (a stub until sub-project 2). On lobby failure, ready players return to the **front** of the queue. Every mutation calls `broadcast('refresh')`.

- [ ] **Step 1: Write `src/orchestrator.ts`**

```ts
/** Sub-project 2 replaces DevOrchestrator with the real RCON-driven implementation. */
export interface Orchestrator {
  setupMatch(matchId: number): Promise<void>;
}

export class DevOrchestrator implements Orchestrator {
  async setupMatch(matchId: number): Promise<void> {
    console.log(`[orchestrator-stub] match ${matchId} created; server setup arrives in sub-project 2`);
  }
}
```

- [ ] **Step 2: Write failing test `tests/matchmaker.test.ts`**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { Matchmaker } from '../src/matchmaker.js';
import { upsertPlayer } from '../src/players.js';
import type { Scheduler } from '../src/lobby.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119800000000${i + 1}`);

class FakeScheduler implements Scheduler {
  timers = new Map<number, () => void>();
  private nextId = 1;
  set(fn: () => void, _ms: number): number {
    const id = this.nextId++;
    this.timers.set(id, fn);
    return id;
  }
  clear(id: number): void {
    this.timers.delete(id);
  }
  fireAll(): void {
    const fns = [...this.timers.values()];
    this.timers.clear();
    fns.forEach((fn) => fn());
  }
}

let db: DB;
let mm: Matchmaker;
let sched: FakeScheduler;
let broadcasts: number;
let setupCalls: number[];

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of IDS) upsertPlayer(db, { steamid: id, name: `n${id.slice(-1)}`, avatar: null }, []);
  sched = new FakeScheduler();
  broadcasts = 0;
  setupCalls = [];
  mm = new Matchmaker(db, {
    broadcast: () => broadcasts++,
    orchestrator: { setupMatch: async (id) => void setupCalls.push(id) },
    scheduler: sched,
    rng: () => 0,
  });
});

function fillQueue() {
  for (const id of IDS) mm.join(id);
}

describe('Matchmaker', () => {
  it('starts a lobby at 8 players', () => {
    fillQueue();
    const st = mm.stateFor(IDS[0]);
    expect(st.lobby?.phase).toBe('ready_check');
    expect(st.queue.count).toBe(0);
  });

  it('runs ready -> vote -> match creation with 4v4 teams', () => {
    fillQueue();
    for (const id of IDS) mm.ready(id);
    for (const id of IDS) mm.vote(id, 'dead_air');
    const match = db.prepare('SELECT * FROM matches').get() as any;
    expect(match.state).toBe('configuring');
    expect(match.campaign).toBe('dead_air');
    const mps = db.prepare('SELECT * FROM match_players WHERE match_id = ?').all(match.id) as any[];
    expect(mps).toHaveLength(8);
    expect(mps.filter((r) => r.team === 'a')).toHaveLength(4);
    expect(setupCalls).toEqual([match.id]);
    const st = mm.stateFor(IDS[0]);
    expect(st.lobby).toBeNull();
    expect(st.match?.campaign).toBe('dead_air');
    expect(st.match?.teamA).toHaveLength(4);
  });

  it('returns ready players to queue front on failed ready check', () => {
    fillQueue();
    mm.ready(IDS[0]);
    mm.ready(IDS[1]);
    sched.fireAll();
    const st = mm.stateFor(IDS[0]);
    expect(st.lobby).toBeNull();
    expect(st.queue.count).toBe(2);
    expect(st.queue.joined).toBe(true);
    expect(mm.stateFor(IDS[2]).queue.joined).toBe(false);
  });

  it('blocks joining while in a lobby', () => {
    fillQueue();
    expect(mm.join(IDS[0]).ok).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/matchmaker.test.ts`
Expected: FAIL — cannot find module `../src/matchmaker.js`.

- [ ] **Step 4: Write `src/matchmaker.ts`**

```ts
import type { DB } from './db.js';
import { Queue, QUEUE_SIZE } from './queue.js';
import { Lobby, realScheduler, type Scheduler, type LobbySnapshot } from './lobby.js';
import { balanceTeams } from './balance.js';
import { getRatings, getPlayer, currentSeasonId } from './players.js';
import { getSetting, getJsonSetting } from './settings.js';
import type { Orchestrator } from './orchestrator.js';

export interface MatchmakerDeps {
  broadcast: (event: string) => void;
  orchestrator: Orchestrator;
  scheduler?: Scheduler;
  rng?: () => number;
}

export interface NamedPlayer {
  steamid: string;
  name: string;
}

export interface StateSnapshot {
  queue: { count: number; joined: boolean };
  lobby:
    | (Omit<LobbySnapshot, 'players'> & { players: NamedPlayer[]; myVote: string | null })
    | null;
  match: {
    id: number;
    state: string;
    campaign: string;
    teamA: NamedPlayer[];
    teamB: NamedPlayer[];
  } | null;
}

export class Matchmaker {
  private queue = new Queue();
  private lobbies = new Map<string, Lobby>();
  private playerLobby = new Map<string, string>();
  private lobbySeq = 0;

  constructor(private db: DB, private deps: MatchmakerDeps) {}

  join(steamid: string): { ok: boolean; error?: string } {
    if (this.playerLobby.has(steamid)) return { ok: false, error: 'already in a lobby' };
    this.queue.join(steamid);
    this.maybeStartLobby();
    this.deps.broadcast('refresh');
    return { ok: true };
  }

  leave(steamid: string): void {
    this.queue.leave(steamid);
    this.deps.broadcast('refresh');
  }

  ready(steamid: string): boolean {
    return this.lobbyFor(steamid)?.markReady(steamid) ?? false;
  }

  vote(steamid: string, campaign: string): boolean {
    return this.lobbyFor(steamid)?.castVote(steamid, campaign) ?? false;
  }

  private lobbyFor(steamid: string): Lobby | undefined {
    const id = this.playerLobby.get(steamid);
    return id ? this.lobbies.get(id) : undefined;
  }

  private maybeStartLobby(): void {
    while (this.queue.count() >= QUEUE_SIZE) {
      const players = this.queue.takeBatch(QUEUE_SIZE);
      const id = `lob_${++this.lobbySeq}`;
      const lobby = new Lobby(
        id,
        players,
        {
          readySeconds: Number(getSetting(this.db, 'ready_seconds') ?? 60),
          voteSeconds: Number(getSetting(this.db, 'vote_seconds') ?? 30),
          mapPool: getJsonSetting<string[]>(this.db, 'map_pool'),
          rng: this.deps.rng,
        },
        {
          onEvent: () => this.deps.broadcast('refresh'),
          onComplete: (result) => this.onLobbyComplete(id, result),
          onFail: (ready) => this.onLobbyFail(id, ready),
        },
        this.deps.scheduler ?? realScheduler,
      );
      this.lobbies.set(id, lobby);
      for (const p of players) this.playerLobby.set(p, id);
    }
  }

  private dissolveLobby(id: string): string[] {
    const lobby = this.lobbies.get(id);
    if (!lobby) return [];
    lobby.destroy();
    this.lobbies.delete(id);
    for (const p of lobby.players) this.playerLobby.delete(p);
    return lobby.players;
  }

  private onLobbyFail(id: string, ready: string[]): void {
    this.dissolveLobby(id);
    this.queue.requeueFront(ready);
    this.maybeStartLobby();
    this.deps.broadcast('refresh');
  }

  private onLobbyComplete(id: string, result: { players: string[]; campaign: string }): void {
    this.dissolveLobby(id);
    const ratings = getRatings(this.db, result.players);
    const { teamA, teamB } = balanceTeams(
      result.players.map((steamid) => {
        const r = ratings.get(steamid)!;
        return { steamid, mu: r.mu, sigma: r.sigma };
      }),
    );
    const season = currentSeasonId(this.db);
    const insertMatch = this.db.prepare(
      "INSERT INTO matches (season_id, state, campaign) VALUES (?, 'configuring', ?)",
    );
    const matchId = Number(insertMatch.run(season, result.campaign).lastInsertRowid);
    const insertMp = this.db.prepare(
      'INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)',
    );
    for (const p of teamA) insertMp.run(matchId, p, 'a');
    for (const p of teamB) insertMp.run(matchId, p, 'b');

    this.deps.orchestrator.setupMatch(matchId).catch((err) => {
      console.error(`orchestrator failed for match ${matchId}:`, err);
    });
    this.deps.broadcast('refresh');
  }

  stateFor(steamid: string): StateSnapshot {
    const named = (id: string): NamedPlayer => ({
      steamid: id,
      name: getPlayer(this.db, id)?.name ?? id,
    });

    const lobby = this.lobbyFor(steamid);
    const snap = lobby?.snapshot();

    const matchRow = this.db
      .prepare(
        `SELECT m.* FROM matches m
         JOIN match_players mp ON mp.match_id = m.id
         WHERE mp.player_id = ? AND m.state IN ('configuring','live')
         ORDER BY m.id DESC LIMIT 1`,
      )
      .get(steamid) as { id: number; state: string; campaign: string } | undefined;

    let match: StateSnapshot['match'] = null;
    if (matchRow) {
      const mps = this.db
        .prepare('SELECT player_id, team FROM match_players WHERE match_id = ?')
        .all(matchRow.id) as { player_id: string; team: 'a' | 'b' }[];
      match = {
        id: matchRow.id,
        state: matchRow.state,
        campaign: matchRow.campaign,
        teamA: mps.filter((r) => r.team === 'a').map((r) => named(r.player_id)),
        teamB: mps.filter((r) => r.team === 'b').map((r) => named(r.player_id)),
      };
    }

    return {
      queue: { count: this.queue.count(), joined: this.queue.has(steamid) },
      lobby: snap && lobby
        ? { ...snap, players: snap.players.map(named), myVote: lobby.myVote(steamid) }
        : null,
      match,
    };
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/matchmaker.test.ts && npx tsc --noEmit`
Expected: PASS (4 tests), clean typecheck.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: matchmaker service wiring queue->lobby->match, orchestrator stub"
```

---

### Task 12: Match pipeline API routes

**Files:**
- Create: `src/routes/api.ts`
- Modify: `src/server.ts`, `src/index.ts`
- Test: `tests/api.test.ts`

- [ ] **Step 1: Write `src/routes/api.ts`**

```ts
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { DB } from '../db.js';
import type { Matchmaker } from '../matchmaker.js';
import { getSession } from '../session.js';
import { getPlayer } from '../players.js';

export interface ApiRouteOpts {
  db: DB;
  matchmaker: Matchmaker;
}

export async function apiRoutes(app: FastifyInstance, opts: ApiRouteOpts): Promise<void> {
  const { db, matchmaker } = opts;

  /** Returns the steamid of an active player or sends the error reply and returns null. */
  function requireActive(req: FastifyRequest, reply: FastifyReply): string | null {
    const steamid = getSession(req);
    if (!steamid) {
      reply.code(401).send({ error: 'not logged in' });
      return null;
    }
    const player = getPlayer(db, steamid);
    if (!player || player.status !== 'active') {
      reply.code(403).send({ error: 'not an active player' });
      return null;
    }
    return steamid;
  }

  app.post('/api/queue/join', async (req, reply) => {
    const steamid = requireActive(req, reply);
    if (!steamid) return;
    const result = matchmaker.join(steamid);
    if (!result.ok) return reply.code(409).send({ error: result.error });
    return { ok: true };
  });

  app.post('/api/queue/leave', async (req, reply) => {
    const steamid = requireActive(req, reply);
    if (!steamid) return;
    matchmaker.leave(steamid);
    return { ok: true };
  });

  app.post('/api/lobby/ready', async (req, reply) => {
    const steamid = requireActive(req, reply);
    if (!steamid) return;
    if (!matchmaker.ready(steamid)) return reply.code(409).send({ error: 'no ready check active' });
    return { ok: true };
  });

  app.post('/api/lobby/vote', async (req, reply) => {
    const steamid = requireActive(req, reply);
    if (!steamid) return;
    const { campaign } = (req.body ?? {}) as { campaign?: string };
    if (!campaign || !matchmaker.vote(steamid, campaign)) {
      return reply.code(409).send({ error: 'invalid vote' });
    }
    return { ok: true };
  });

  app.get('/api/state', async (req, reply) => {
    const steamid = requireActive(req, reply);
    if (!steamid) return;
    return matchmaker.stateFor(steamid);
  });
}
```

- [ ] **Step 2: Modify `src/server.ts` — construct the matchmaker and register api routes**

Add imports:

```ts
import { Matchmaker } from './matchmaker.js';
import { DevOrchestrator, type Orchestrator } from './orchestrator.js';
import { apiRoutes } from './routes/api.js';
```

Extend `ServerDeps` with an optional orchestrator and expose the matchmaker for later tasks:

```ts
export interface ServerDeps {
  config: Config;
  db: DB;
  verifyLogin?: typeof realVerifyLogin;
  fetchPersona?: typeof realFetchPersona;
  hub?: Hub;
  orchestrator?: Orchestrator;
}
```

Inside `buildServer`, after the hub is created:

```ts
  const matchmaker = new Matchmaker(deps.db, {
    broadcast: (event) => hub.broadcast(event),
    orchestrator: deps.orchestrator ?? new DevOrchestrator(),
  });
  app.decorate('matchmaker', matchmaker);
  await app.register(apiRoutes, { db: deps.db, matchmaker });
```

And add the module augmentation at the bottom of `src/server.ts`:

```ts
declare module 'fastify' {
  interface FastifyInstance {
    matchmaker: Matchmaker;
  }
}
```

- [ ] **Step 3: Write failing test `tests/api.test.ts`**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { authedCookie } from './helpers.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119800000000${i + 1}`);

let db: DB;
let app: FastifyInstance;
let cookies: Record<string, Record<string, string>>;

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({ config: loadConfig({}), db });
  cookies = {};
  for (const id of IDS) cookies[id] = authedCookie(app, db, id);
});

async function post(url: string, steamid: string, payload?: object) {
  return app.inject({ method: 'POST', url, cookies: cookies[steamid], payload });
}

describe('match pipeline over HTTP', () => {
  it('rejects unauthenticated and inactive players', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/queue/join' })).statusCode).toBe(401);
    const invited = authedCookie(app, db, '76561198000000099', { active: false });
    const res = await app.inject({ method: 'POST', url: '/api/queue/join', cookies: invited });
    expect(res.statusCode).toBe(403);
  });

  it('drives queue -> ready -> vote -> match via the API', async () => {
    for (const id of IDS) expect((await post('/api/queue/join', id)).statusCode).toBe(200);

    let state = (await app.inject({ method: 'GET', url: '/api/state', cookies: cookies[IDS[0]] })).json();
    expect(state.lobby.phase).toBe('ready_check');

    for (const id of IDS) expect((await post('/api/lobby/ready', id)).statusCode).toBe(200);
    for (const id of IDS) {
      expect((await post('/api/lobby/vote', id, { campaign: 'no_mercy' })).statusCode).toBe(200);
    }

    state = (await app.inject({ method: 'GET', url: '/api/state', cookies: cookies[IDS[0]] })).json();
    expect(state.lobby).toBeNull();
    expect(state.match.campaign).toBe('no_mercy');
    expect(state.match.state).toBe('configuring');
    expect(state.match.teamA).toHaveLength(4);
    expect(state.match.teamB).toHaveLength(4);
  });

  it('queue leave works and rejects bad votes', async () => {
    await post('/api/queue/join', IDS[0]);
    expect((await post('/api/queue/leave', IDS[0])).statusCode).toBe(200);
    expect((await post('/api/lobby/vote', IDS[0], { campaign: 'no_mercy' })).statusCode).toBe(409);
  });
});
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/api.test.ts && npx tsc --noEmit`
Expected: PASS (3 tests), clean typecheck. Note: the full-pipeline test never waits on timers — every phase advances via the all-players-acted early paths.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: match pipeline http api"
```

---

### Task 13: Dev mode routes

**Files:**
- Create: `src/routes/dev.ts`
- Modify: `src/server.ts`
- Test: `tests/dev.test.ts`

Purpose: let one human (or one browser) exercise the whole pipeline. Fake players are real DB rows with steamids in a reserved `765611990000000xx` range.

- [ ] **Step 1: Write `src/routes/dev.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import type { DB } from '../db.js';
import type { Matchmaker } from '../matchmaker.js';
import type { Config } from '../config.js';
import { upsertPlayer, activatePlayer } from '../players.js';
import { setSession } from '../session.js';
import { QUEUE_SIZE } from '../queue.js';
import type { Hub } from '../ws.js';

export interface DevRouteOpts {
  config: Config;
  db: DB;
  matchmaker: Matchmaker;
  hub: Hub;
}

let fakeSeq = 0;

export async function devRoutes(app: FastifyInstance, opts: DevRouteOpts): Promise<void> {
  const { db, matchmaker } = opts;

  app.get('/api/dev/enabled', async () => ({ ok: true }));

  /** Log in as any steamid without Steam. */
  app.post('/api/dev/login', async (req, reply) => {
    const { steamid } = (req.body ?? {}) as { steamid?: string };
    if (!steamid || !/^\d{17}$/.test(steamid)) {
      return reply.code(400).send({ error: 'steamid must be 17 digits' });
    }
    upsertPlayer(db, { steamid, name: `dev_${steamid.slice(-4)}`, avatar: null }, []);
    activatePlayer(db, steamid);
    setSession(reply, steamid);
    return { ok: true, steamid };
  });

  /** Create fake active players and queue them until the queue would pop. */
  app.post('/api/dev/fill', async () => {
    const added: string[] = [];
    while (added.length < QUEUE_SIZE) {
      const steamid = `76561199000000${String(++fakeSeq).padStart(3, '0')}`;
      upsertPlayer(db, { steamid, name: `fake_${fakeSeq}`, avatar: null }, []);
      activatePlayer(db, steamid);
      const res = matchmaker.join(steamid);
      if (!res.ok) break;
      added.push(steamid);
      if (matchmaker.stateFor(steamid).lobby) break; // lobby popped, stop filling
    }
    return { ok: true, added };
  });

  /** Ready-up every player currently in any lobby. */
  app.post('/api/dev/ready-all', async () => {
    for (const steamid of matchmaker.lobbyMembers()) matchmaker.ready(steamid);
    return { ok: true };
  });

  /** Vote for every player in any lobby (default: first campaign in the pool). */
  app.post('/api/dev/vote-all', async (req) => {
    const { campaign } = (req.body ?? {}) as { campaign?: string };
    for (const steamid of matchmaker.lobbyMembers()) {
      matchmaker.vote(steamid, campaign ?? 'no_mercy');
    }
    return { ok: true };
  });

  /** Abort all open matches so the pipeline can be exercised repeatedly.
      (Until sub-project 2, matches otherwise sit in 'configuring' forever.) */
  app.post('/api/dev/clear-matches', async () => {
    db.prepare("UPDATE matches SET state = 'aborted' WHERE state IN ('configuring','live')").run();
    opts.hub.broadcast('refresh');
    return { ok: true };
  });
}
```

- [ ] **Step 2: Add `lobbyMembers()` to `src/matchmaker.ts`**

Add this public method to the `Matchmaker` class:

```ts
  /** All players currently in any lobby (dev tooling). */
  lobbyMembers(): string[] {
    return [...this.playerLobby.keys()];
  }
```

- [ ] **Step 3: Modify `src/server.ts` — register dev routes only in dev mode**

Add import:

```ts
import { devRoutes } from './routes/dev.js';
```

After the api route registration in `buildServer`:

```ts
  if (deps.config.devMode) {
    await app.register(devRoutes, { config: deps.config, db: deps.db, matchmaker, hub });
  }
```

- [ ] **Step 4: Write failing test `tests/dev.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';

describe('dev routes', () => {
  it('is 404 when dev mode is off', async () => {
    const app = await buildServer({ config: loadConfig({}), db: openDb(':memory:') });
    expect((await app.inject({ method: 'GET', url: '/api/dev/enabled' })).statusCode).toBe(404);
  });

  it('drives a full match with one real user + fakes', async () => {
    const app = await buildServer({ config: loadConfig({ DEV_MODE: '1' }), db: openDb(':memory:') });

    const login = await app.inject({
      method: 'POST', url: '/api/dev/login', payload: { steamid: '76561198000000001' },
    });
    expect(login.statusCode).toBe(200);
    const cookie = login.cookies.find((c) => c.name === 'pug_session')!;
    const cookies = { pug_session: cookie.value };

    await app.inject({ method: 'POST', url: '/api/queue/join', cookies });
    await app.inject({ method: 'POST', url: '/api/dev/fill', cookies });
    await app.inject({ method: 'POST', url: '/api/dev/ready-all', cookies });
    await app.inject({ method: 'POST', url: '/api/dev/vote-all', cookies, payload: { campaign: 'dead_air' } });

    const state = (await app.inject({ method: 'GET', url: '/api/state', cookies })).json();
    expect(state.match.campaign).toBe('dead_air');
    expect(state.match.teamA.length + state.match.teamB.length).toBe(8);
  });
});
```

Note: `/api/dev/fill` stops as soon as the lobby pops, so with 1 real player queued it adds exactly 7 fakes.

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/dev.test.ts && npx vitest run && npx tsc --noEmit`
Expected: dev tests pass (2), full suite passes, clean typecheck.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: dev mode routes for single-human testing"
```

---

### Task 14: Frontend

**Files:**
- Create: `public/index.html`, `public/style.css`, `public/app.js`

No build step, no framework — one static page that renders whichever phase the player is in and re-fetches `/api/state` whenever the websocket says `refresh`.

- [ ] **Step 1: Write `public/index.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>L4D1 PUG</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <header>
    <h1>L4D1 PUG</h1>
    <div id="whoami"></div>
  </header>

  <main>
    <section id="login" hidden>
      <p>Ranked 4v4 pick-up games for Left 4 Dead.</p>
      <a class="btn" href="/auth/steam">Sign in through Steam</a>
    </section>

    <section id="register" hidden>
      <p>You need an invite code to play.</p>
      <input id="invite-code" placeholder="invite code">
      <button id="register-btn" class="btn">Register</button>
      <p id="register-error" class="error"></p>
    </section>

    <section id="queue" hidden>
      <p><span id="queue-count">0</span>/8 in queue</p>
      <button id="join-btn" class="btn">Join queue</button>
      <button id="leave-btn" class="btn" hidden>Leave queue</button>
    </section>

    <section id="ready" hidden>
      <h2>Match found — ready up! (<span id="ready-timer"></span>s)</h2>
      <button id="ready-btn" class="btn">READY</button>
      <ul id="ready-list"></ul>
    </section>

    <section id="vote" hidden>
      <h2>Vote for a campaign (<span id="vote-timer"></span>s)</h2>
      <div id="vote-options"></div>
    </section>

    <section id="match" hidden>
      <h2>Match ready</h2>
      <p id="match-info"></p>
      <div class="teams">
        <div><h3>Team A</h3><ul id="team-a"></ul></div>
        <div><h3>Team B</h3><ul id="team-b"></ul></div>
      </div>
      <p class="note">Server assignment lands in the next milestone — for now, arrange the game manually.</p>
    </section>
  </main>

  <div id="devpanel" hidden>
    <h3>dev</h3>
    <input id="dev-steamid" placeholder="steamid64" value="76561198000000001">
    <button id="dev-login">login</button>
    <button id="dev-fill">fill queue</button>
    <button id="dev-ready">ready all</button>
    <button id="dev-vote">vote all</button>
    <button id="dev-clear">clear matches</button>
  </div>

  <script src="/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Write `public/style.css`**

```css
* { box-sizing: border-box; }
body {
  margin: 0; min-height: 100vh;
  font-family: system-ui, sans-serif;
  background: #16181d; color: #e6e6e6;
}
header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 0.75rem 1.25rem; background: #0f1114; border-bottom: 1px solid #2a2e36;
}
h1 { font-size: 1.1rem; margin: 0; color: #c33; }
main { max-width: 640px; margin: 2rem auto; padding: 0 1rem; }
section { background: #1d2026; border: 1px solid #2a2e36; border-radius: 8px; padding: 1.5rem; }
.btn {
  display: inline-block; padding: 0.6rem 1.4rem; border: 0; border-radius: 6px;
  background: #c33; color: #fff; font-size: 1rem; cursor: pointer; text-decoration: none;
}
.btn:hover { background: #e44; }
input { padding: 0.5rem; border-radius: 6px; border: 1px solid #2a2e36; background: #0f1114; color: #e6e6e6; }
.error { color: #e66; }
.note { color: #999; font-size: 0.9rem; }
.teams { display: flex; gap: 2rem; }
.teams > div { flex: 1; }
ul { list-style: none; padding: 0; }
li { padding: 0.25rem 0; border-bottom: 1px solid #2a2e36; }
li.ready::after { content: " ✔"; color: #6c6; }
#vote-options { display: flex; flex-wrap: wrap; gap: 0.5rem; }
#vote-options .btn.voted { outline: 2px solid #fff; }
#devpanel {
  position: fixed; bottom: 0; right: 0; padding: 0.5rem;
  background: #0f1114; border: 1px dashed #555; font-size: 0.8rem;
}
#devpanel h3 { margin: 0 0 0.25rem; }
```

- [ ] **Step 3: Write `public/app.js`**

```js
const $ = (id) => document.getElementById(id);
const CAMPAIGN_NAMES = {
  no_mercy: 'No Mercy',
  death_toll: 'Death Toll',
  dead_air: 'Dead Air',
  blood_harvest: 'Blood Harvest',
};

let state = null;

function show(id) {
  for (const s of document.querySelectorAll('main > section')) s.hidden = s.id !== id;
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method ?? 'POST',
    headers: { 'content-type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return res;
}

async function refresh() {
  const meRes = await fetch('/api/me');
  if (meRes.status === 401) { $('whoami').textContent = ''; show('login'); return; }
  const me = await meRes.json();
  $('whoami').textContent = me.name;
  if (me.status !== 'active') { show('register'); return; }
  const stRes = await fetch('/api/state');
  if (!stRes.ok) { show('queue'); return; }
  state = await stRes.json();
  render();
}

function secondsLeft(deadline) {
  return Math.max(0, Math.round((deadline - Date.now()) / 1000));
}

function render() {
  if (!state) return;
  const { queue, lobby, match } = state;
  if (match) {
    $('match-info').textContent =
      `Campaign: ${CAMPAIGN_NAMES[match.campaign] ?? match.campaign} — status: ${match.state}`;
    for (const [elId, team] of [['team-a', match.teamA], ['team-b', match.teamB]]) {
      $(elId).innerHTML = team.map((p) => `<li>${p.name}</li>`).join('');
    }
    show('match');
  } else if (lobby && lobby.phase === 'ready_check') {
    $('ready-timer').textContent = secondsLeft(lobby.deadline);
    $('ready-list').innerHTML = lobby.players
      .map((p) => `<li class="${lobby.ready.includes(p.steamid) ? 'ready' : ''}">${p.name}</li>`)
      .join('');
    show('ready');
  } else if (lobby && lobby.phase === 'map_vote') {
    $('vote-timer').textContent = secondsLeft(lobby.deadline);
    $('vote-options').innerHTML = lobby.options
      .map((c) => {
        const votes = lobby.votes[c] ?? 0;
        const cls = lobby.myVote === c ? 'btn voted' : 'btn';
        return `<button class="${cls}" data-campaign="${c}">${CAMPAIGN_NAMES[c] ?? c} (${votes})</button>`;
      })
      .join('');
    for (const btn of $('vote-options').querySelectorAll('button')) {
      btn.onclick = () => api('/api/lobby/vote', { body: { campaign: btn.dataset.campaign } }).then(refresh);
    }
    show('vote');
  } else {
    $('queue-count').textContent = queue.count;
    $('join-btn').hidden = queue.joined;
    $('leave-btn').hidden = !queue.joined;
    show('queue');
  }
}

$('register-btn').onclick = async () => {
  const res = await api('/api/register', { body: { code: $('invite-code').value.trim() } });
  if (!res.ok) $('register-error').textContent = 'Invalid invite code.';
  refresh();
};
$('join-btn').onclick = () => api('/api/queue/join').then(refresh);
$('leave-btn').onclick = () => api('/api/queue/leave').then(refresh);
$('ready-btn').onclick = () => api('/api/lobby/ready').then(refresh);

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onmessage = () => refresh();
  ws.onclose = () => setTimeout(connectWs, 2000);
}

async function initDevPanel() {
  const res = await fetch('/api/dev/enabled');
  if (!res.ok) return;
  $('devpanel').hidden = false;
  $('dev-login').onclick = () =>
    api('/api/dev/login', { body: { steamid: $('dev-steamid').value.trim() } }).then(refresh);
  $('dev-fill').onclick = () => api('/api/dev/fill').then(refresh);
  $('dev-ready').onclick = () => api('/api/dev/ready-all').then(refresh);
  $('dev-vote').onclick = () => api('/api/dev/vote-all').then(refresh);
  $('dev-clear').onclick = () => api('/api/dev/clear-matches').then(refresh);
}

setInterval(() => { if (state?.lobby) render(); }, 1000); // tick countdowns
connectWs();
initDevPanel();
refresh();
```

- [ ] **Step 4: Manual verification**

```bash
npm run dev
```

Then in a browser at `http://localhost:8080`:

1. Dev panel visible bottom-right. Click **login** (default steamid) — the queue section should appear with your dev name in the header.
2. Click **Join queue** — count becomes 1/8.
3. Click **fill queue** — ready screen appears (websocket refresh; countdown ticking).
4. Click **READY**, then **ready all** — vote screen appears.
5. Vote for a campaign, then **vote all** — match screen appears with two teams of 4.
6. Reload the page — match screen persists (state comes from the DB).
7. Click **clear matches** — back to the queue screen, ready for another run.

Expected: no console errors; every transition happens without a manual reload.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: static frontend with dev panel"
```

---

### Task 15: README and final verification

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write `README.md`**

```markdown
# pug — L4D1 ranked PUG system

Web backend + (eventually) game-server plugin for ranked 4v4 Left 4 Dead 1
pick-up games. Design spec: `docs/superpowers/specs/2026-07-30-l4d1-pug-system-design.md`.

## Status

Sub-project 1 (backend core) complete: Steam login, invite gate, queue →
ready-check → map-vote → SR-balanced teams, websocket live updates, dev mode.
Matches stop at state `configuring` — real server orchestration (RCON +
logaddress) is sub-project 2.

## Run

    npm install
    npm run dev        # dev mode on :8080 (DEV_MODE=1, fake logins enabled)
    npm test           # vitest
    npm run typecheck  # tsc --noEmit

## Environment

| Var | Default | Notes |
|---|---|---|
| PORT | 8080 | |
| PUBLIC_URL | http://localhost:8080 | must match what Steam redirects back to |
| DB_PATH | data/pug.db | SQLite; WAL mode |
| COOKIE_SECRET | dev-secret-change-me | **set in production** |
| ADMIN_STEAMIDS | (empty) | comma-separated SteamID64s, auto-active + admin |
| STEAM_API_KEY | (none) | optional; enables persona names/avatars |
| DEV_MODE | off | `1` enables /api/dev/* and the dev panel |

The invite code lives in the DB: `settings.invite_code` (default `change-me`).
Change it: `sqlite3 data/pug.db "UPDATE settings SET value='...' WHERE key='invite_code'"`.

## Layout

- `src/` — Fastify app: `matchmaker.ts` (queue/lobby pipeline), `lobby.ts`
  (ready-check + vote state machine), `balance.ts` (OpenSkill team split),
  `orchestrator.ts` (stub until sub-project 2), `routes/`.
- `public/` — static frontend, no build step.
- `tests/` — vitest.
```

- [ ] **Step 2: Full verification**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all tests green (≈30 across 10 files), clean typecheck.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "docs: README; sub-project 1 complete"
```

---

## Out of scope for this plan (later sub-projects)

- **Sub-project 2:** real `Orchestrator` (server pool, RCON match setup, logaddress UDP listener, match token), the `pug-match` SourcePawn plugin, deployment to the Dallas box (systemd + Caddy).
- **Sub-project 3:** rating updates on match completion, rating history, profiles, leaderboard, match history pages, Discord webhooks.
- **Sub-project 4:** hours/versus-games eligibility gates, admin tooling, bans.
