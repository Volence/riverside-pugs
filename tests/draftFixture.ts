import { openDb, type DB } from '../src/db.js';
import { activatePlayer, upsertPlayer } from '../src/players.js';
import * as E from '../src/events/events.js';
import * as D from '../src/events/drafts.js';
import { ADMIN, NOW, START, must, stageBody } from './eventFixture.js';

/** A draft-kind event open for signups (drafts plan D1), built the way
 *  entryFixture builds a team event: the switch at everyone, 21 activated
 *  players (P[0..20]) with Discord and 5 completed PUGs each, SR 1000 + 25*i
 *  through player_ratings, and the event published and in registration with
 *  signups closing 2 hours and the draft 1 hour before the start. */
export const P = Array.from({ length: 21 }, (_, i) => `765611990000009${String(i).padStart(2, '0')}`);
export const PUGS = 5;

export interface DraftFixture { db: DB; eventId: number; slug: string; closeAt: string; draftAt: string; startsAt: string }

const hoursBefore = (iso: string, h: number) => new Date(Date.parse(iso) - h * 3_600_000).toISOString();

/** Completed PUGs for one player, each its own match. */
export function givePugs(db: DB, steamid: string, n: number): void {
  const match = db.prepare("INSERT INTO matches (season_id, state, campaign, kind, ended_at) VALUES ((SELECT id FROM seasons ORDER BY id DESC LIMIT 1), 'completed', 'no_mercy', 'pug', '2026-09-01 10:00:00')");
  const mp = db.prepare("INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, 'a')");
  for (let k = 0; k < n; k++) mp.run(Number(match.run().lastInsertRowid), steamid);
}

export const rate = (db: DB, steamid: string, sr: number) =>
  db.prepare('INSERT OR REPLACE INTO player_ratings (player_id, season_id, mu, sigma) VALUES (?, (SELECT id FROM seasons WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1), ?, 1)')
    .run(steamid, sr / 100 + 2);

/** startsAt defaults to the fixed START; HTTP tests pass one relative to the
 *  wall clock, as entryFixture's do. */
export function draftFixture(o: { startsAt?: string; publish?: boolean; open?: boolean } = {}): DraftFixture {
  const db = openDb(':memory:');
  db.prepare("UPDATE settings SET value = 'everyone' WHERE key = 'competitive_enabled'").run();
  upsertPlayer(db, { steamid: ADMIN, name: 'boss', avatar: null }, [ADMIN]);
  P.forEach((s, i) => {
    upsertPlayer(db, { steamid: s, name: `d${i}`, avatar: null }, []);
    activatePlayer(db, s);
    db.prepare('UPDATE players SET discord_id = ? WHERE steamid = ?').run(`dd${i}`, s);
    givePugs(db, s, PUGS);
    rate(db, s, 1000 + 25 * i);
  });
  const startsAt = o.startsAt ?? START;
  const closeAt = hoursBefore(startsAt, 2);
  const draftAt = hoursBefore(startsAt, 1);
  const ev = must(E.createEvent(db, {
    by: ADMIN, now: NOW,
    fields: { name: 'Draft Night', startsAt, entryKind: 'draft', draft: { signupsCloseAt: closeAt, draftAt } },
  }));
  must(E.addStage(db, { eventId: ev.id, by: ADMIN, stage: stageBody(db, { advanceCount: null }), now: NOW }));
  if (o.publish !== false) must(E.publishEvent(db, { eventId: ev.id, by: ADMIN, now: NOW }));
  if (o.publish !== false && o.open !== false) must(E.openRegistration(db, { eventId: ev.id, by: ADMIN, now: NOW }));
  return { db, eventId: ev.id, slug: ev.slug, closeAt, draftAt, startsAt };
}

/** Plan D2a: all 21 players signed up a second apart in P order, signups
 *  closed, 5 teams, captains picked by SR (P[16..20]) and, unless told not
 *  to, the cut published (pool P[0..14], bench P[15]). With balance, Auto-balance
 *  is then chosen and the teams balanced. */
export function cutDraft(o: { publish?: boolean; balance?: boolean; startsAt?: string; now?: Date } = {}): DraftFixture {
  const f = draftFixture(o.startsAt ? { startsAt: o.startsAt } : {});
  const t0 = o.now ? o.now.getTime() - 60_000 : NOW.getTime();
  const at = o.now ?? NOW;
  P.forEach((s, i) => must(D.signUp(f.db, { eventId: f.eventId, steamid: s, captainPref: 'willing', note: null, now: new Date(t0 + i * 1000) })));
  must(D.closeSignups(f.db, { eventId: f.eventId, actor: ADMIN, now: at }));
  must(D.pickCaptains(f.db, { eventId: f.eventId, actor: ADMIN, now: at }));
  if (o.publish !== false) must(D.publishCut(f.db, { eventId: f.eventId, actor: ADMIN, now: at }));
  if (o.balance) {
    must(D.chooseTeamMode(f.db, { eventId: f.eventId, mode: 'auto', actor: ADMIN, now: at }));
    must(D.autoBalance(f.db, { eventId: f.eventId, actor: ADMIN, now: at }));
  }
  return f;
}
