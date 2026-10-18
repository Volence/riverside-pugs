import type { DB } from './db.js';
import { addMember, createPerson, personByLabel, type AddResult } from './evaderPeople.js';
import type { SeedPerson } from './evaderSeed.js';

/**
 * Write the seed people (src/evaderSeed.ts). One transaction; a dry run rolls
 * it back and only reports. Idempotent: a person that exists is built on (the
 * evader_flags migration may already have made dethisa), and an account
 * already on a DIFFERENT person is reported as a conflict, never moved.
 */

export interface SeedReport { created: string[]; added: string[]; already: string[]; conflicts: string[] }

export function seedPeople(
  db: DB, people: readonly SeedPerson[], opts: { by?: string; now?: Date; dryRun?: boolean } = {},
): SeedReport {
  const by = opts.by ?? 'system';
  const now = opts.now ?? new Date();
  const report: SeedReport = { created: [], added: [], already: [], conflicts: [] };
  const note = (r: AddResult, what: string) => {
    if (r === 'added') report.added.push(what);
    else if (r === 'already') report.already.push(what);
    else report.conflicts.push(`${what}: ${r}`);
  };
  const ROLLBACK = Symbol('dry run');
  const run = db.transaction(() => {
    for (const p of people) {
      let id = personByLabel(db, p.label)?.id;
      if (id === undefined) {
        id = createPerson(db, p.label, p.note, by, now);
        report.created.push(p.label);
      }
      const byName = p.steamByName.flatMap((n) =>
        (db.prepare('SELECT steamid FROM players WHERE name = ? ORDER BY steamid').all(n) as { steamid: string }[]).map((r) => r.steamid));
      for (const steamid of [...new Set([...p.steam, ...byName])]) note(addMember(db, id, 'steam', steamid, by, 'seed', now), `${p.label} steam ${steamid}`);
      for (const d of p.discord) note(addMember(db, id, 'discord', d, by, 'seed', now), `${p.label} discord ${d}`);
    }
    if (opts.dryRun) throw ROLLBACK;
  });
  try {
    run();
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }
  return report;
}
