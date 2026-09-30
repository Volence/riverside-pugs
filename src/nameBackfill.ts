import type { DB } from './db.js';
import { parseLogDatagram } from './logParse.js';
import { steamId64Of } from './steamId.js';
import { resolveAlias } from './aliases.js';
import { normaliseName, recordNameUses } from './playerNames.js';

/**
 * Seed name history from srcds log files (scripts/backfill-names.ts has the
 * how and why of the counting). Pure over the text it is given and the
 * database, so it can be tested without a log directory.
 */

export interface LogSighting {
  steamid: string;
  name: string;
  /** SQLite datetime, read off the line's own stamp. */
  at: string;
  /** The PUG match token this sighting belongs to, or null in a log file
   *  that never carried one (pub play, practice, before pug-match). */
  token: string | null;
}

const STAMP = /^L (\d{2})\/(\d{2})\/(\d{4}) - (\d{2}:\d{2}:\d{2}): /;
/** A pug-match line: `PUG <token> <VERB> ...`. Any verb will do, since all
 *  that is wanted is which match the file was recording. */
const PUG_LINE = /^PUG (\S{8,64}) [A-Z_]+/;
/** The engine's own player entity, opening the line: "name<uid><STEAM_x:y:z><team>".
 *  Lazy on the name, so the FIRST well-formed entity wins. A name crafted to
 *  contain one could move a line onto somebody else; that is why a sighting
 *  only counts for a player the site rostered in that match (planNameBackfill),
 *  and why PUGNAME lines, which put the name last, are read as well. No
 *  quote in the name: two lines srcds wrote without a newline between them
 *  otherwise read as one enormous "name". */
const ENTITY = /^"([^"]{1,127}?)<\d+><(STEAM_[0-5]:[01]:\d{1,10})><[^>]*>"(?:\s|$)/;

/** Every name sighting in one log file, each tagged with the match token the
 *  file was carrying at that point. A sighting before the file's first token
 *  takes that first token: players connect at map load, a moment before the
 *  plugin's first line of the map. */
export function sightingsFromLog(text: string): LogSighting[] {
  const out: { steamid: string; name: string; at: string; line: number }[] = [];
  const tokens: { line: number; token: string }[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, i) => {
    const stamp = STAMP.exec(raw);
    if (!stamp) return;
    const [, mm, dd, yyyy, hms] = stamp;
    const at = `${yyyy}-${mm}-${dd} ${hms}`;
    const body = raw.slice(stamp[0].length);
    const pug = PUG_LINE.exec(body);
    if (pug) {
      tokens.push({ line: i, token: pug[1] });
      return;
    }
    if (body.startsWith('PUGNAME ')) {
      const ev = parseLogDatagram(Buffer.from(raw, 'utf8'));
      if (ev?.kind === 'name') out.push({ steamid: ev.steamid, name: ev.name, at, line: i });
      return;
    }
    const ent = ENTITY.exec(body);
    if (!ent) return;
    // STEAM_x:0:0 is no account: the engine's placeholder on a LAN server.
    const steamid = /:0:0$/.test(ent[2]) ? null : steamId64Of(ent[2]);
    if (!steamid) return;
    out.push({ steamid, name: ent[1], at, line: i });
  });
  return out.map((s) => {
    let token: string | null = null;
    for (const t of tokens) {
      if (t.line > s.line) {
        token ??= t.token;
        break;
      }
      token = t.token;
    }
    return { steamid: s.steamid, name: s.name, at: s.at, token };
  });
}

export interface PlannedUse { steamid: string; matchKey: string; name: string; at: string }

export interface NameBackfillPlan {
  uses: PlannedUse[];
  /** Sightings dropped, by why: the token is not a completed match here, the
   *  player was not rostered in it, or (without byDay) the file had no token. */
  skipped: { unknownToken: number; notRostered: number; noToken: number };
}

/**
 * Turn sightings into name uses, one per player per name per match.
 *
 * A token counts only when it is a COMPLETED match in this database, and a
 * sighting only when its player (after alias resolution) was rostered in it,
 * which is the same rule the live path applies. The match key is the live
 * one, `m:<id>`, so a match the live path already folded is not counted
 * twice. With byDay, sightings from files with no token count once per
 * player per name per day under `log:<date>`, for logs from before the
 * plugin existed, and only for players the site knows.
 */
export function planNameBackfill(
  db: DB, sightings: LogSighting[], opts: { byDay: boolean },
): NameBackfillPlan {
  const skipped = { unknownToken: 0, notRostered: 0, noToken: 0 };
  const matchOf = new Map<string, number | null>();
  const matchByToken = db.prepare("SELECT id FROM matches WHERE token = ? AND state = 'completed'");
  const rostered = db.prepare('SELECT 1 FROM match_players WHERE match_id = ? AND player_id = ?');
  const known = db.prepare('SELECT 1 FROM players WHERE steamid = ?');
  const seen = new Map<string, PlannedUse>();
  for (const s of sightings) {
    const n = normaliseName(s.name);
    if (!n) continue;
    const steamid = resolveAlias(db, s.steamid);
    let matchKey: string;
    if (s.token === null) {
      // Without a match there is no roster to check against, so a pub
      // counts only for somebody the site knows: a stranger's pub names are
      // nobody's history here.
      if (!opts.byDay || !known.get(steamid)) { skipped.noToken += 1; continue; }
      matchKey = `log:${s.at.slice(0, 10)}`;
    } else {
      if (!matchOf.has(s.token)) {
        matchOf.set(s.token, (matchByToken.get(s.token) as { id: number } | undefined)?.id ?? null);
      }
      const id = matchOf.get(s.token)!;
      if (id === null) { skipped.unknownToken += 1; continue; }
      if (!rostered.get(id, steamid)) { skipped.notRostered += 1; continue; }
      matchKey = `m:${id}`;
    }
    // One use per name per match, as the ledger keys it, and the earliest
    // sighting is when it was first used. Its spelling is the one kept.
    const k = `${steamid}\n${matchKey}\n${n.key}`;
    const prev = seen.get(k);
    if (!prev || s.at < prev.at) seen.set(k, { steamid, matchKey, name: n.display, at: s.at });
  }
  return { uses: [...seen.values()].sort((a, b) => a.at.localeCompare(b.at)), skipped };
}

/** Write a plan. Never queues the digest: these are old names, not news.
 *  Oldest first, so first-seen dates come out right. Idempotent, like every
 *  other write to the ledger. */
export function applyNameBackfill(db: DB, plan: NameBackfillPlan): number {
  const before = (db.prepare('SELECT COUNT(*) AS n FROM player_name_uses').get() as { n: number }).n;
  db.transaction(() => {
    for (const u of plan.uses) {
      recordNameUses(db, u.steamid, u.matchKey, [{ source: 'ingame', name: u.name }], u.at, { queue: false });
    }
  })();
  return (db.prepare('SELECT COUNT(*) AS n FROM player_name_uses').get() as { n: number }).n - before;
}
