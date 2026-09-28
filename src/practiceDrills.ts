/**
 * Stored replay drills and their codes.
 *
 * The site turns a replay moment into a drill spec (src/drillSpec.ts) and
 * files it here under a short code. A player types `!drill K7QX` on any
 * server running practice mode and the practice plugin fetches the spec by
 * that code over HTTPS. There is no lease and no server push: the code is
 * the whole hand-off, which is why it has to be short enough to type in
 * game chat and impossible to misread off a screen.
 *
 * Codes are public by design. Anyone with one can fetch the spec, which only
 * ever describes a finished match (the create route refuses anything else),
 * so there is nothing in it that the public replay viewer does not already
 * show.
 */
import { randomInt } from 'node:crypto';
import type { DB } from './db.js';
import type { DrillBody, DrillSpec } from './drillSpec.js';

/** No 0/O, 1/I/L: every character here survives being read off a stream,
 *  typed on a phone, or said out loud in voice. */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Four characters is about 920,000 codes, plenty for a site this size.
 *  Once four-character codes start colliding the fifth character comes in
 *  on its own (see `newCode`), so the space never runs out and no code
 *  already handed out changes. */
const SHORT_LEN = 4;
const LONG_LEN = 5;
const TRIES_PER_LENGTH = 8;

/** What a code looks like on the way in: the alphabet only, either case.
 *  Checked before any query so a fetch for garbage is answered without one. */
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${SHORT_LEN},${LONG_LEN}}$`);

/** New drills a player may create in an hour. A drill the same moment
 *  already has costs nothing and is not counted. Twenty is far above what
 *  anyone clicking through a replay does, and low enough that a script
 *  cannot fill the table. */
export const DRILLS_PER_HOUR = 20;

/** Round a moment to the 100 ms the replay is sampled at, so two clicks on
 *  the same frame from slightly different playback positions share a code. */
export function momentKey(tMs: number): number {
  return Math.round(tMs / 100) * 100;
}

/** Upper-case and check a code typed by a person or a plugin; null when it
 *  cannot be one. */
export function normalizeCode(raw: string): string | null {
  const up = raw.trim().toUpperCase();
  return CODE_RE.test(up) ? up : null;
}

function randomCode(len: number): string {
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

/** A code no drill has yet. Tries short codes first, then long ones. */
function newCode(db: DB, pick: (len: number) => string): string {
  const taken = db.prepare('SELECT 1 FROM practice_drills WHERE code = ?');
  for (const len of [SHORT_LEN, LONG_LEN]) {
    for (let i = 0; i < TRIES_PER_LENGTH; i++) {
      const code = pick(len);
      if (!taken.get(code)) return code;
    }
  }
  // 31^5 is 28 million; reaching here means the picker is broken, not full.
  throw new Error('practice drills: could not find a free code');
}

export interface DrillMoment {
  matchId: number | null;
  ordinal: number;
  half: number;
  tMs: number;
}

/** The drill already stored for this moment of this match, if any. */
export function drillForMoment(db: DB, m: DrillMoment): DrillSpec | null {
  if (m.matchId === null) return null;
  const row = db.prepare(
    'SELECT spec_json FROM practice_drills WHERE match_id = ? AND ordinal = ? AND half = ? AND t_ms = ?',
  ).get(m.matchId, m.ordinal, m.half, momentKey(m.tMs)) as { spec_json: string } | undefined;
  return row ? JSON.parse(row.spec_json) as DrillSpec : null;
}

/** How many drills this player created in the last hour. */
export function drillsCreatedSince(db: DB, steamid: string, sinceIso: string): number {
  return (db.prepare(
    "SELECT COUNT(*) AS n FROM practice_drills WHERE created_by = ? AND created_at > datetime(?)",
  ).get(steamid, sinceIso) as { n: number }).n;
}

/**
 * File a drill and return it with its code, or the drill the same moment
 * already has. `reused` says which, so the caller can leave a reuse out of
 * the rate limit.
 *
 * One transaction around the lookup and the insert, so two clicks racing on
 * the same moment cannot both insert. better-sqlite3 is synchronous and the
 * unique index on the moment backs it up regardless.
 */
export function createDrill(
  db: DB, body: DrillBody, m: DrillMoment, createdBy: string | null,
  pick: (len: number) => string = randomCode,
): { spec: DrillSpec; reused: boolean } {
  return db.transaction(() => {
    const existing = drillForMoment(db, m);
    if (existing) return { spec: existing, reused: true };
    const code = newCode(db, pick);
    // The code leads the object so it leads the JSON, where a person
    // reading a fetched spec looks first.
    const spec: DrillSpec = { code, ...body };
    db.prepare(
      `INSERT INTO practice_drills (code, spec_json, created_by, match_id, ordinal, half, t_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(code, JSON.stringify(spec), createdBy, m.matchId, m.ordinal, m.half, momentKey(m.tMs));
    return { spec, reused: false };
  })();
}

/**
 * The stored spec JSON for a code, counting the fetch. Returned as the
 * stored string rather than re-serialised, so what the plugin receives is
 * byte for byte what was filed. Null for an unknown or malformed code.
 */
export function fetchDrill(db: DB, rawCode: string, nowIso: string = new Date().toISOString()): string | null {
  const code = normalizeCode(rawCode);
  if (!code) return null;
  const row = db.prepare('SELECT spec_json FROM practice_drills WHERE code = ?')
    .get(code) as { spec_json: string } | undefined;
  if (!row) return null;
  db.prepare(
    'UPDATE practice_drills SET fetch_count = fetch_count + 1, last_fetched_at = datetime(?) WHERE code = ?',
  ).run(nowIso, code);
  return row.spec_json;
}
