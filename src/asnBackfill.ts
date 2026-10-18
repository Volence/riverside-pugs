import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { DB } from './db.js';
import type { AsnLookup } from './asnTable.js';
import { hashIp } from './playerNetworks.js';
import { getSetting } from './settings.js';
import { steamId64Of } from './steamId.js';

/**
 * One-off backfill of player_networks.asn / as_org for connections recorded
 * before the network tag existed (spec section 1, "Backfill").
 *
 * Those rows have no address to look up: only the salted hash was ever kept.
 * The in-game chat logs on every box do carry raw addresses on each join line,
 * so each logged address is hashed with THIS install's salt, matched to
 * player_networks, and every row on that hash gets the provider. A row no log
 * line matches stays NULL, which reads as "unknown", never "residential".
 *
 * Addresses are held in memory for the run and never written or printed.
 */

const JOIN_LINE = /\((STEAM_\d:[01]:\d{1,10})\s*\|\s*(\d{1,3}(?:\.\d{1,3}){3})\)/;
export const CHAT_LOG_NAME = /^server_\d+_chat_\d{4}_\d{2}_\d{2}\.log(\.gz)?$/;

export function parseChatJoinLine(line: string): { steamid: string; ip: string } | null {
  const m = JOIN_LINE.exec(line);
  if (!m) return null;
  const steamid = steamId64Of(m[1]);
  return steamid ? { steamid, ip: m[2] } : null;
}

export function* chatLogLines(dir: string): Generator<string> {
  for (const name of readdirSync(dir).filter((n) => CHAT_LOG_NAME.test(n)).sort()) {
    const buf = readFileSync(join(dir, name));
    yield* (name.endsWith('.gz') ? gunzipSync(buf) : buf).toString('utf8').split('\n');
  }
}

export interface BackfillReport {
  lines: number; joins: number;
  /** Distinct addresses in the logs. */
  addresses: number;
  /** Of those, how many match a player_networks hash. */
  matchedAddresses: number;
  updatedRows: number;
  /** Matched, but no range in the table covers the address. */
  unresolved: number;
}

export function backfillNetworkAsn(
  db: DB, lines: Iterable<string>, table: AsnLookup, opts: { dryRun?: boolean } = {},
): BackfillReport {
  // hashIp would mint a fresh salt on a database without one, and every hash
  // would then match nothing while looking like it worked.
  if (!getSetting(db, 'ip_hash_salt')) {
    throw new Error('this database has no ip_hash_salt: it has never recorded a connection, so nothing can match');
  }
  const report: BackfillReport = { lines: 0, joins: 0, addresses: 0, matchedAddresses: 0, updatedRows: 0, unresolved: 0 };
  const ips = new Set<string>();
  for (const line of lines) {
    report.lines += 1;
    const j = parseChatJoinLine(line);
    if (!j) continue;
    report.joins += 1;
    ips.add(j.ip);
  }
  report.addresses = ips.size;
  const count = db.prepare('SELECT COUNT(*) AS n FROM player_networks WHERE ip_hash = ?');
  const update = db.prepare('UPDATE player_networks SET asn = ?, as_org = ? WHERE ip_hash = ? AND asn IS NULL');
  const ROLLBACK = Symbol('dry run');
  const run = db.transaction(() => {
    for (const ip of ips) {
      const h = hashIp(db, ip);
      if ((count.get(h) as { n: number }).n === 0) continue;
      report.matchedAddresses += 1;
      const hit = table.lookup(ip);
      if (!hit) { report.unresolved += 1; continue; }
      report.updatedRows += update.run(hit.asn, hit.org, h).changes;
    }
    if (opts.dryRun) throw ROLLBACK;
  });
  try {
    run();
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  } finally {
    ips.clear();
  }
  return report;
}
