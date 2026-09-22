import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB, DEFAULT_SETTINGS } from '../src/db.js';
import { getSetting } from '../src/settings.js';
import { SETTINGS_SCHEMA } from '../src/settingsSchema.js';
import { upsertPlayer, activatePlayer, currentSeasonId } from '../src/players.js';
import { recentCoPlayers, resolveByName } from '../src/discord/reportButton.js';

let db: DB;

beforeEach(() => {
  db = openDb(':memory:');
});

const IDS = Array.from({ length: 6 }, (_, i) => `7656119900000010${i}`);
const [ME, ALICE, BOB1, BOB2, CARL, DEE] = IDS;

const seedPlayers = (d: DB) => {
  const names: Record<string, string> = {
    [ME]: 'me', [ALICE]: 'Alice', [BOB1]: 'Bob', [BOB2]: 'bob',
    [CARL]: 'Carl_99', [DEE]: 'Dee%Dee',
  };
  for (const id of IDS) {
    upsertPlayer(d, { steamid: id, name: names[id], avatar: null }, []);
    activatePlayer(d, id);
  }
};

// `matches` requires season_id and campaign, both NOT NULL. A fresh database
// seeds "Season 1", so currentSeasonId always has something to return.
const seedMatch = (d: DB, matchId: number, players: string[], state = 'completed') => {
  d.prepare(
    `INSERT INTO matches (id, season_id, state, campaign, created_at)
     VALUES (?, ?, ?, 'l4d_vs_smalltown', '2026-09-22T00:00:00.000Z')`,
  ).run(matchId, currentSeasonId(d), state);
  const ins = d.prepare("INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, 'a')");
  for (const p of players) ins.run(matchId, p);
};

describe('report button schema', () => {
  it('creates the pending_reports and report_message tables', () => {
    const names = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('pending_reports', 'report_message')",
    ).all() as { name: string }[]).map((r) => r.name).sort();
    expect(names).toEqual(['pending_reports', 'report_message']);
  });

  it('holds report_message to a single row', () => {
    const ins = db.prepare(
      "INSERT INTO report_message (id, channel_id, message_id, hash, updated_at) VALUES (?, 'c1', 'm1', 'h', '2026-09-22T00:00:00.000Z')",
    );
    ins.run(1);
    expect(() => ins.run(2)).toThrow();
  });

  it('defaults the report channel setting to empty', () => {
    expect(getSetting(db, 'discord_report_channel_id')).toBe('');
  });

  it('keeps a pending report only for a real player', () => {
    expect(() => db.prepare(
      "INSERT INTO pending_reports (reporter_id, category, text, typed_name, candidates, created_at) VALUES ('76561199000000099', 'griefing', '', 'bob', '[]', '2026-09-22T00:00:00.000Z')",
    ).run()).toThrow();
  });
});

describe('settings parity', () => {
  it('gives every default a schema entry and every schema entry a default', () => {
    const defaults = Object.keys(DEFAULT_SETTINGS).sort();
    const schema = SETTINGS_SCHEMA.map((s) => s.key).sort();
    expect(defaults).toEqual(schema);
  });
});

import { COMMAND_DEFS, REPORT_LABELS } from '../src/discord/commands.js';

describe('details wording', () => {
  const report = () => COMMAND_DEFS.find((c) => c.name === 'report')!;
  const details = () => report().options!.find((o) => o.name === 'details')!;

  it('does not lead with the map', () => {
    expect(details().description.toLowerCase()).not.toContain('map');
  });

  it('asks for what happened, in the reporter\'s own words', () => {
    expect(details().description).toBe('What happened, in your own words');
  });

  it('stays inside Discord\'s 100 character limit', () => {
    expect(details().description.length).toBeLessThanOrEqual(100);
  });

  it('exports the category labels so the form can share them', () => {
    expect(REPORT_LABELS.unsafe).toBe('Safety concern (handled privately)');
  });
});

describe('recentCoPlayers', () => {
  beforeEach(() => { seedPlayers(db); });

  it('lists people from my matches, most recent first, never me', () => {
    seedMatch(db, 1, [ME, ALICE]);
    seedMatch(db, 2, [ME, CARL]);
    expect(recentCoPlayers(db, ME).map((c) => c.name)).toEqual(['Carl_99', 'Alice']);
  });

  it('lists someone once however many matches we shared', () => {
    seedMatch(db, 1, [ME, ALICE]);
    seedMatch(db, 2, [ME, ALICE]);
    expect(recentCoPlayers(db, ME)).toHaveLength(1);
  });

  it('is empty for someone who has never played', () => {
    expect(recentCoPlayers(db, ME)).toEqual([]);
  });

  it('honours the limit', () => {
    seedMatch(db, 1, [ME, ALICE, BOB1, CARL]);
    expect(recentCoPlayers(db, ME, 2)).toHaveLength(2);
  });

  it('does not list someone from a configuring match', () => {
    seedMatch(db, 1, [ME, ALICE], 'configuring');
    expect(recentCoPlayers(db, ME)).toEqual([]);
  });

  it('lists someone from a match that fell apart, because that is when you report them', () => {
    seedMatch(db, 1, [ME, ALICE], 'aborted');
    expect(recentCoPlayers(db, ME).map((c) => c.name)).toEqual(['Alice']);
  });
});

describe('resolveByName', () => {
  beforeEach(() => { seedPlayers(db); });

  it('finds one exact name regardless of case', () => {
    expect(resolveByName(db, 'ALICE').map((c) => c.steamid)).toEqual([ALICE]);
  });

  it('prefers exact matches over substrings', () => {
    // 'Bob' and 'bob' both match exactly; 'Bobby' would only match as a
    // substring and must not dilute an exact hit.
    upsertPlayer(db, { steamid: '76561199000000199', name: 'Bobby', avatar: null }, []);
    expect(resolveByName(db, 'bob').map((c) => c.steamid).sort()).toEqual([BOB1, BOB2].sort());
  });

  it('falls back to a substring when nothing matches exactly', () => {
    expect(resolveByName(db, 'arl').map((c) => c.steamid)).toEqual([CARL]);
  });

  it('returns nothing for a name nobody has', () => {
    expect(resolveByName(db, 'nobody')).toEqual([]);
  });

  it('treats LIKE wildcards as ordinary characters', () => {
    // '%' must not match everything, and '_' must not match any character.
    expect(resolveByName(db, '%').map((c) => c.steamid)).toEqual([DEE]);
    expect(resolveByName(db, 'Carl_').map((c) => c.steamid)).toEqual([CARL]);
  });

  it('ignores surrounding whitespace', () => {
    expect(resolveByName(db, '  Alice  ').map((c) => c.steamid)).toEqual([ALICE]);
  });

  it('returns at most the limit', () => {
    expect(resolveByName(db, 'e', 2).length).toBeLessThanOrEqual(2);
  });
});
