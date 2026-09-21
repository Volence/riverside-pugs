import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import {
  ENDORSE_ERROR_TEXT, ENDORSE_KINDS, ENDORSE_LABEL,
  allTitles, endorseState, endorsementSummary, giveEndorsement, pendingEndorsements, titleFromCounts,
} from '../src/endorsements.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119800000000${i + 1}`);
const OUTSIDER = '76561198000000099';
let db: DB;

/** A match with all eight IDS on it, four a side, ended `hoursAgo` hours ago. */
function seedMatch(id: number, opts: { state?: string; hoursAgo?: number } = {}): void {
  db.prepare(
    `INSERT INTO matches (id, season_id, state, campaign, winner, ended_at)
     VALUES (?, 1, ?, 'no_mercy', 'a', datetime('now', ?))`,
  ).run(id, opts.state ?? 'completed', `-${opts.hoursAgo ?? 0} hours`);
  IDS.forEach((p, i) => {
    db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)').run(id, p, i < 4 ? 'a' : 'b');
  });
}

const rowCount = () => (db.prepare('SELECT COUNT(*) AS n FROM endorsements').get() as { n: number }).n;

beforeEach(() => {
  db = openDb(':memory:');
  [...IDS, OUTSIDER].forEach((id, i) => upsertPlayer(db, { steamid: id, name: `n${i}`, avatar: null }, []));
});

describe('schema', () => {
  it('has no negative kind and refuses an unknown one at the table', () => {
    seedMatch(1);
    expect([...ENDORSE_KINDS]).toEqual(['caller', 'clutch', 'vibes']);
    expect(ENDORSE_LABEL).toEqual({ caller: 'Caller', clutch: 'Clutch', vibes: 'Good vibes' });
    expect(() => db.prepare(
      "INSERT INTO endorsements (match_id, from_id, to_id, kind, created_at) VALUES (1, ?, ?, 'toxic', datetime('now'))",
    ).run(IDS[0], IDS[1])).toThrow();
  });

  it('has a sentence for every refusal', () => {
    for (const text of Object.values(ENDORSE_ERROR_TEXT)) expect(text.length).toBeGreaterThan(10);
  });
});

describe('giveEndorsement', () => {
  it('records one and reports what is left of the budget', () => {
    seedMatch(1);
    expect(giveEndorsement(db, { matchId: 1, from: IDS[0], to: IDS[5], kind: 'caller' })).toEqual({ ok: true, remaining: 1 });
    expect(rowCount()).toBe(1);
  });

  it('lets a player endorse across teams', () => {
    seedMatch(1);
    expect(giveEndorsement(db, { matchId: 1, from: IDS[0], to: IDS[7], kind: 'vibes' }).ok).toBe(true);
  });

  it('refuses self endorsement', () => {
    seedMatch(1);
    expect(giveEndorsement(db, { matchId: 1, from: IDS[0], to: IDS[0], kind: 'clutch' })).toEqual({ ok: false, error: 'self' });
  });

  it('refuses a kind that does not exist', () => {
    seedMatch(1);
    expect(giveEndorsement(db, { matchId: 1, from: IDS[0], to: IDS[1], kind: 'toxic' })).toEqual({ ok: false, error: 'bad_kind' });
  });

  it('refuses a giver who was not on the roster', () => {
    seedMatch(1);
    expect(giveEndorsement(db, { matchId: 1, from: OUTSIDER, to: IDS[1], kind: 'caller' })).toEqual({ ok: false, error: 'not_rostered' });
  });

  it('refuses a recipient who was not on the roster', () => {
    seedMatch(1);
    expect(giveEndorsement(db, { matchId: 1, from: IDS[0], to: OUTSIDER, kind: 'caller' })).toEqual({ ok: false, error: 'target_not_rostered' });
  });

  it('refuses a match that does not exist or did not complete', () => {
    seedMatch(2, { state: 'aborted' });
    expect(giveEndorsement(db, { matchId: 1, from: IDS[0], to: IDS[1], kind: 'caller' })).toEqual({ ok: false, error: 'no_match' });
    expect(giveEndorsement(db, { matchId: 2, from: IDS[0], to: IDS[1], kind: 'caller' })).toEqual({ ok: false, error: 'not_completed' });
  });

  it('closes after endorse_window_hours, and the window is the setting', () => {
    seedMatch(1, { hoursAgo: 25 });
    expect(giveEndorsement(db, { matchId: 1, from: IDS[0], to: IDS[1], kind: 'caller' })).toEqual({ ok: false, error: 'closed' });
    setSetting(db, 'endorse_window_hours', '48');
    expect(giveEndorsement(db, { matchId: 1, from: IDS[0], to: IDS[1], kind: 'caller' }).ok).toBe(true);
  });

  it('allows one endorsement per recipient per match, whatever the kind', () => {
    seedMatch(1);
    giveEndorsement(db, { matchId: 1, from: IDS[0], to: IDS[1], kind: 'caller' });
    expect(giveEndorsement(db, { matchId: 1, from: IDS[0], to: IDS[1], kind: 'clutch' })).toEqual({ ok: false, error: 'duplicate' });
    expect(rowCount()).toBe(1);
  });

  it('never spends more than the budget, however many times it is asked', () => {
    seedMatch(1);
    expect(giveEndorsement(db, { matchId: 1, from: IDS[0], to: IDS[1], kind: 'caller' })).toEqual({ ok: true, remaining: 1 });
    expect(giveEndorsement(db, { matchId: 1, from: IDS[0], to: IDS[2], kind: 'caller' })).toEqual({ ok: true, remaining: 0 });
    for (let i = 3; i < 8; i += 1) {
      expect(giveEndorsement(db, { matchId: 1, from: IDS[0], to: IDS[i], kind: 'caller' })).toEqual({ ok: false, error: 'budget' });
    }
    expect(rowCount()).toBe(2);
  });

  it('keeps each match and each giver on its own budget', () => {
    seedMatch(1);
    seedMatch(2);
    giveEndorsement(db, { matchId: 1, from: IDS[0], to: IDS[1], kind: 'caller' });
    giveEndorsement(db, { matchId: 1, from: IDS[0], to: IDS[2], kind: 'caller' });
    expect(giveEndorsement(db, { matchId: 2, from: IDS[0], to: IDS[1], kind: 'caller' }).ok).toBe(true);
    expect(giveEndorsement(db, { matchId: 1, from: IDS[3], to: IDS[1], kind: 'caller' }).ok).toBe(true);
  });
});

describe('endorseState', () => {
  it('lists the seven other players and what this giver already gave', () => {
    seedMatch(1);
    giveEndorsement(db, { matchId: 1, from: IDS[0], to: IDS[5], kind: 'clutch' });
    const st = endorseState(db, 1, IDS[0]);
    expect(st.eligible).toBe(true);
    expect(st.reason).toBeNull();
    expect(st.budget).toBe(2);
    expect(st.remaining).toBe(1);
    expect(st.given).toEqual([{ to: IDS[5], kind: 'clutch' }]);
    expect(st.candidates.map((c) => c.steamid).sort()).toEqual(IDS.slice(1).sort());
    expect(st.closesAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('never shows one giver what another gave', () => {
    seedMatch(1);
    giveEndorsement(db, { matchId: 1, from: IDS[0], to: IDS[5], kind: 'clutch' });
    expect(endorseState(db, 1, IDS[5]).given).toEqual([]);
  });

  it('says why somebody may not endorse, with nothing else attached', () => {
    seedMatch(1, { hoursAgo: 30 });
    expect(endorseState(db, 1, OUTSIDER)).toMatchObject({ eligible: false, reason: 'not_rostered', candidates: [], given: [], remaining: 0 });
    expect(endorseState(db, 1, IDS[0])).toMatchObject({ eligible: false, reason: 'closed' });
    expect(endorseState(db, 9, IDS[0])).toMatchObject({ eligible: false, reason: 'no_match' });
  });
});

describe('titleFromCounts', () => {
  const c = (caller: number, clutch: number, vibes: number) => ({ caller, clutch, vibes });
  it('needs enough games', () => expect(titleFromCounts(c(9, 0, 0), 9, 5, 10)).toBeNull());
  it('needs enough of the kind', () => expect(titleFromCounts(c(4, 0, 0), 20, 5, 10)).toBeNull());
  it('gives the strict plurality', () => expect(titleFromCounts(c(6, 5, 1), 20, 5, 10)).toBe('caller'));
  it('gives nothing on a tie, so a title cannot flicker', () => expect(titleFromCounts(c(6, 6, 1), 20, 5, 10)).toBeNull());
});

describe('endorsementSummary and allTitles', () => {
  /** `n` endorsements of `kind` for IDS[1], one per match, from IDS[0]. */
  function farm(kind: string, n: number, firstMatch: number): void {
    for (let i = 0; i < n; i += 1) {
      seedMatch(firstMatch + i);
      expect(giveEndorsement(db, { matchId: firstMatch + i, from: IDS[0], to: IDS[1], kind }).ok).toBe(true);
    }
  }

  it('counts per kind, a per match rate, and nothing about who gave them', () => {
    farm('caller', 3, 1);
    farm('vibes', 1, 4);
    const s = endorsementSummary(db, IDS[1]);
    expect(s).toEqual({ counts: { caller: 3, clutch: 0, vibes: 1 }, total: 4, perMatch: 1, title: null });
    expect(Object.keys(s).sort()).toEqual(['counts', 'perMatch', 'title', 'total']);
  });

  it('awards the title once both thresholds are met', () => {
    setSetting(db, 'endorse_title_min', '3');
    setSetting(db, 'endorse_title_min_games', '4');
    farm('caller', 3, 1);
    expect(endorsementSummary(db, IDS[1]).title).toBeNull();
    farm('vibes', 1, 4);
    expect(endorsementSummary(db, IDS[1]).title).toBe('caller');
    expect(allTitles(db).get(IDS[1])).toBe('caller');
    expect(allTitles(db).has(IDS[0])).toBe(false);
  });

  it('drops the endorsements of a match that was voided afterwards', () => {
    farm('caller', 2, 1);
    db.prepare("UPDATE matches SET state = 'aborted' WHERE id = 1").run();
    expect(endorsementSummary(db, IDS[1])).toMatchObject({ counts: { caller: 1, clutch: 0, vibes: 0 }, total: 1, perMatch: 1 });
  });

  it('is zeros for somebody nobody has endorsed', () => {
    expect(endorsementSummary(db, OUTSIDER)).toEqual({ counts: { caller: 0, clutch: 0, vibes: 0 }, total: 0, perMatch: 0, title: null });
  });
});

describe('pendingEndorsements', () => {
  it('lists open matches where this player still has budget, newest first', () => {
    seedMatch(1);
    seedMatch(2);
    seedMatch(3, { hoursAgo: 30 });
    seedMatch(4, { state: 'aborted' });
    giveEndorsement(db, { matchId: 1, from: IDS[0], to: IDS[1], kind: 'caller' });
    giveEndorsement(db, { matchId: 1, from: IDS[0], to: IDS[2], kind: 'caller' });
    giveEndorsement(db, { matchId: 2, from: IDS[0], to: IDS[1], kind: 'caller' });
    expect(pendingEndorsements(db, IDS[0])).toEqual([{ matchId: 2, remaining: 1 }]);
    expect(pendingEndorsements(db, OUTSIDER)).toEqual([]);
  });
});
