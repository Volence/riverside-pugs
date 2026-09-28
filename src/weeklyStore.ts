import type { DB } from './db.js';
import { AWARDS, awardDef, computeWeek, weekStartOf, type AwardKind, type AwardResult, type Winner } from './weeklyAwards.js';
import { computeRecap, type Recap } from './weeklyRecap.js';

/**
 * Frozen weeks. A closed week is computed once and written here; the Discord
 * post, the site's past weeks and the profile chips read only these rows, so
 * a later void or rating recompute cannot quietly change who won.
 */

export interface FrozenWeek { week: string; frozenAt: string; postedAt: string | null; awards: AwardResult[]; recap: Recap }
export interface PlayerAward { award: string; label: string; count: number; weeks: string[] }

export function freezeWeek(db: DB, week: string, now: Date = new Date()): boolean {
  // Calendar-invalid input (2026-13-01, 2026-01-32) must not reach
  // weekStartOf, which would silently read it through Date's own
  // rollover; catch it here so both bad shapes report the same error.
  if (Number.isNaN(Date.parse(`${week}T00:00:00Z`)) || weekStartOf(new Date(`${week}T00:00:00Z`)) !== week) {
    throw new Error(`not a week start: ${week}`);
  }
  if (!(week < weekStartOf(now))) {
    throw new Error(`week not closed yet: ${week}`);
  }
  return db.transaction(() => {
    const exists = db.prepare('SELECT 1 FROM weekly_award_weeks WHERE week_start = ?').get(week);
    if (exists) return false;
    const awards = computeWeek(db, week);
    const recap = computeRecap(db, week);
    db.prepare("INSERT INTO weekly_award_weeks (week_start, frozen_at, weekly_recap) VALUES (?, datetime('now'), ?)")
      .run(week, JSON.stringify(recap));
    const ins = db.prepare(
      'INSERT INTO weekly_awards (week_start, award, kind, player_id, value, games, detail) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (const a of awards) for (const w of a.winners) ins.run(week, a.key, a.kind, w.steamid, w.value, w.games, w.detail);
    return true;
  })();
}

const KIND_ORDER: Record<AwardKind, number> = { avg: 0, total: 1, single: 2 };

export function frozenWeek(db: DB, week: string): FrozenWeek | null {
  const head = db.prepare('SELECT frozen_at, posted_at, weekly_recap FROM weekly_award_weeks WHERE week_start = ?')
    .get(week) as { frozen_at: string; posted_at: string | null; weekly_recap: string } | undefined;
  if (!head) return null;
  const rows = db.prepare(
    `SELECT wa.award, wa.kind, wa.player_id AS steamid, p.name, wa.value, wa.games, wa.detail
     FROM weekly_awards wa JOIN players p ON p.steamid = wa.player_id
     WHERE wa.week_start = ? ORDER BY p.name`,
  ).all(week) as (Winner & { award: string; kind: AwardKind })[];
  const byKey = new Map<string, AwardResult>();
  for (const r of rows) {
    const def = awardDef(r.award);
    if (!def) continue;   // an award since removed from the catalog
    const id = `${r.award}:${r.kind}`;
    const a = byKey.get(id) ?? { key: def.key, label: def.label, group: def.group, kind: r.kind, winners: [] };
    a.winners.push({ steamid: r.steamid, name: r.name, value: r.value, games: r.games, detail: r.detail });
    byKey.set(id, a);
  }
  const order = (a: AwardResult) => AWARDS.findIndex((d) => d.key === a.key) * 3 + KIND_ORDER[a.kind];
  return {
    week, frozenAt: head.frozen_at, postedAt: head.posted_at,
    awards: [...byKey.values()].sort((a, b) => order(a) - order(b)),
    recap: JSON.parse(head.weekly_recap) as Recap,
  };
}

export function frozenWeeks(db: DB): string[] {
  return (db.prepare('SELECT week_start FROM weekly_award_weeks ORDER BY week_start DESC').all() as { week_start: string }[])
    .map((r) => r.week_start);
}

export function playerWeeklyAwards(db: DB, steamid: string): PlayerAward[] {
  const rows = db.prepare(
    'SELECT DISTINCT award, week_start FROM weekly_awards WHERE player_id = ? ORDER BY week_start DESC',
  ).all(steamid) as { award: string; week_start: string }[];
  const out = new Map<string, PlayerAward>();
  for (const r of rows) {
    const def = awardDef(r.award);
    if (!def || def.group === 'shame') continue;
    const a = out.get(r.award) ?? { award: r.award, label: def.label, count: 0, weeks: [] };
    a.count++; a.weeks.push(r.week_start);
    out.set(r.award, a);
  }
  return [...out.values()].sort((a, b) => b.count - a.count || b.weeks[0].localeCompare(a.weeks[0]) || a.label.localeCompare(b.label));
}
