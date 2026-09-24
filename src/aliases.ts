import type { DB } from './db.js';
import type { LogEvent } from './logParse.js';
import type { Dump, DumpPlayer, DumpSkill } from './dumpParse.js';
import { MergeError } from './mergePlayers.js';

/**
 * Second Steam accounts, pointed at the one account their owner really is.
 *
 * A merge (see mergePlayers) fixes the history. This is what stops the same
 * person making the same mess again the next night: the alt's SteamID is
 * recorded here, and every line the game server sends about it is rewritten to
 * the canonical account before anything acts on it. Reconnecting on the alt
 * then rosters them as themselves rather than inventing a second identity with
 * a second rating.
 *
 * Deliberately a rewrite at the door rather than a check at each use. There
 * are a dozen places a SteamID arrives from the game (rosters, live stats,
 * events, chat, leave and return, abandons), and a rule enforced in eleven of
 * them is not a rule.
 */

export interface Alias {
  steamid: string;
  canonical: string;
  created_at: string;
  created_by: string;
}

/**
 * Point `steamid` at `canonical`.
 *
 * Refuses a chain. If aliases could point at aliases, resolution would need a
 * loop, that loop would need a cycle guard, and a cycle in this table would
 * hang the log listener rather than fail visibly. One hop, always, is worth
 * more than the flexibility: to re-point an alias, remove it and add it again.
 */
export function addAlias(
  db: DB, opts: { steamid: string; canonical: string; by: string },
): void {
  const { steamid, canonical, by } = opts;
  if (steamid === canonical) throw new MergeError('an account cannot be an alias of itself');
  if (db.prepare('SELECT 1 FROM player_aliases WHERE steamid = ?').get(canonical)) {
    throw new MergeError(`${canonical} is itself an alias; point ${steamid} at its canonical account instead`);
  }
  if (db.prepare('SELECT 1 FROM player_aliases WHERE canonical_id = ?').get(steamid)) {
    throw new MergeError(`${steamid} is the canonical account for another alias; it cannot become one`);
  }
  db.prepare(
    `INSERT INTO player_aliases (steamid, canonical_id, created_at, created_by)
     VALUES (?, ?, datetime('now'), ?)
     ON CONFLICT(steamid) DO UPDATE SET canonical_id = excluded.canonical_id`,
  ).run(steamid, canonical, by);
}

export function removeAlias(db: DB, steamid: string): void {
  db.prepare('DELETE FROM player_aliases WHERE steamid = ?').run(steamid);
}

/** The account this SteamID really belongs to. Its own id when it is not an
 *  alias, so every caller can resolve unconditionally. */
export function resolveAlias(db: DB, steamid: string): string {
  const row = db.prepare('SELECT canonical_id FROM player_aliases WHERE steamid = ?').get(steamid) as
    | { canonical_id: string } | undefined;
  return row?.canonical_id ?? steamid;
}

/** Every alias folded into one account, for the admin panel. */
export function aliasesOf(db: DB, canonical: string): Alias[] {
  return db.prepare(
    'SELECT steamid, canonical_id AS canonical, created_at, created_by FROM player_aliases WHERE canonical_id = ? ORDER BY created_at',
  ).all(canonical) as Alias[];
}

/** Which fields on each event kind hold a SteamID. */
const ID_FIELDS: Partial<Record<LogEvent['kind'], readonly string[]>> = {
  leave: ['steamid'],
  return: ['steamid'],
  abandon: ['steamid'],
  player: ['steamid'],
  match_roster: ['steamid'],
  live_stat: ['steamid'],
  live_event: ['actor', 'target'],
  chat: ['steamid'],
  signon_drop: ['steamid'],
  entered: ['steamid'],
  player_net: ['steamid'],
  lilac_flag: ['steamid'],
  cvar_flag: ['steamid'],
  say: ['steamid'],
  name: ['steamid'],
  input_burst: ['steamid'],
  input_cap: ['steamid'],
  round_stat: ['steamid'],
};

/**
 * Rewrite every SteamID on an event to its canonical account.
 *
 * Returns the SAME object when nothing changed, which is the common case by a
 * wide margin: this runs on every datagram, and live stats alone arrive ten
 * times a second per player.
 */
export function canonicalise(db: DB, ev: LogEvent): LogEvent {
  const fields = ID_FIELDS[ev.kind];
  if (!fields) return ev;
  const row = ev as unknown as Record<string, unknown>;
  let out: Record<string, unknown> | null = null;
  for (const f of fields) {
    const id = row[f];
    if (typeof id !== 'string' || !id) continue;
    const canonical = resolveAlias(db, id);
    if (canonical === id) continue;
    out ??= { ...row };
    out[f] = canonical;
  }
  return (out ?? row) as unknown as LogEvent;
}

/**
 * The same rewrite for the RCON dump, which does not come through the log
 * listener and so never met canonicalise(). Without it a merged alt's STAT and
 * SKILL lines name an account whose roster row was already rewritten to the
 * canonical one, match nothing, and are dropped: the person is rated on a
 * match with no stats.
 *
 * Somebody who played parts of one match on both accounts has two STAT lines
 * that now carry one id. They are added up, since every field is a counter,
 * and the earlier joined_map and the first team seen are kept.
 */
export function canonicaliseDump(db: DB, d: Dump): Dump {
  const players = new Map<string, DumpPlayer>();
  for (const p of d.players) {
    const id = resolveAlias(db, p.steamid);
    const seen = players.get(id);
    if (!seen) {
      players.set(id, { ...p, steamid: id });
      continue;
    }
    seen.joinedMap = Math.min(seen.joinedMap ?? 0, p.joinedMap ?? 0);
    seen.sidmg += p.sidmg;
    seen.sikill += p.sikill;
    seen.ck += p.ck;
    seen.ff += p.ff;
    seen.rev += p.rev;
  }
  const skills = new Map<string, DumpSkill>();
  for (const s of d.skills) {
    const id = resolveAlias(db, s.steamid);
    const seen = skills.get(id);
    if (!seen) {
      skills.set(id, { steamid: id, stats: { ...s.stats } });
      continue;
    }
    for (const [k, v] of Object.entries(s.stats)) seen.stats[k] = (seen.stats[k] ?? 0) + v;
  }
  return { ...d, players: [...players.values()], skills: [...skills.values()] };
}
