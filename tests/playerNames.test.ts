import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer } from '../src/players.js';
import { addAlias } from '../src/aliases.js';
import { setSetting } from '../src/settings.js';
import {
  alsoKnownAs, foldMatchNames, nameHistory, normaliseName, noteInGameName, recordNameUses, takeRenameDigest,
} from '../src/playerNames.js';

const AMOUR = '76561199014394259';
const OTHER = '76561198000000002';
const ALT = '76561198000000003';

let db: DB;

function liveMatch(id: number, players: string[]): void {
  db.prepare(
    "INSERT INTO matches (id, season_id, state, campaign, went_live_at) VALUES (?, 1, 'live', 'dead_air', '2026-09-19 22:00:00')",
  ).run(id);
  for (const p of players) {
    db.prepare("INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, 'a')").run(id, p);
  }
}
function complete(id: number, at: Date): void {
  db.prepare("UPDATE matches SET state = 'completed' WHERE id = ?").run(id);
  foldMatchNames(db, id, at);
}
const names = (steamid: string) => nameHistory(db, steamid).map((r) => [r.name, r.matches]);

beforeEach(() => {
  db = openDb(':memory:');
  upsertPlayer(db, { steamid: AMOUR, name: 'amour plastique', avatar: 'a.jpg' }, []);
  upsertPlayer(db, { steamid: OTHER, name: 'other', avatar: 'o.jpg' }, []);
});

describe('normaliseName', () => {
  it('drops the engine prefixes, invisible characters and extra spacing', () => {
    expect(normaliseName('(S)amour plastique')).toEqual({ display: 'amour plastique', key: 'amour plastique' });
    expect(normaliseName('(S)(1)  amour   plastique ')?.display).toBe('amour plastique');
    expect(normaliseName('(1)v')?.display).toBe('v');
    expect(normaliseName('v\u200B')?.display).toBe('v');
  });

  it('refuses a blank name', () => {
    expect(normaliseName('')).toBeNull();
    expect(normaliseName('   ')).toBeNull();
    expect(normaliseName('\u200B')).toBeNull();
    expect(normaliseName('(S)')).toBeNull();
  });

  it('folds case and one clan tag into the key, not the display', () => {
    expect(normaliseName('Amour Plastique')?.key).toBe('amour plastique');
    expect(normaliseName('[RS] v')).toEqual({ display: '[RS] v', key: 'v' });
    expect(normaliseName('v |RS|')?.key).toBe('v');
    // A tag with nothing left is the name itself.
    expect(normaliseName('[RS]')?.key).toBe('[rs]');
  });
});

describe('foldMatchNames', () => {
  it('counts the in-game names seen while live and the Steam persona, once per match', () => {
    liveMatch(1, [AMOUR]);
    noteInGameName(db, AMOUR, 'amour plastique', 1);
    noteInGameName(db, AMOUR, '(S)amour plastique', 1);
    noteInGameName(db, AMOUR, 'AMOUR PLASTIQUE', 1);
    complete(1, new Date('2026-09-19T23:00:00Z'));
    expect(names(AMOUR)).toEqual([['amour plastique', 1]]);
    expect(nameHistory(db, AMOUR)[0].sources).toEqual(['ingame', 'steam']);
  });

  it('falls back to the last in-game name seen before the match went live', () => {
    db.prepare('UPDATE players SET avatar = NULL WHERE steamid = ?').run(AMOUR);
    noteInGameName(db, AMOUR, 'warmup name', null, new Date('2026-09-19T21:55:00Z'));
    liveMatch(1, [AMOUR]);
    complete(1, new Date('2026-09-19T23:00:00Z'));
    // No avatar: players.name was never a Steam lookup, so it is not a persona.
    expect(names(AMOUR)).toEqual([['warmup name', 1]]);
  });

  it('ignores a last name seen after the match went live, such as on a practice server while the result was retried', () => {
    db.prepare('UPDATE players SET avatar = NULL WHERE steamid = ?').run(AMOUR);
    noteInGameName(db, AMOUR, 'warmup name', null, new Date('2026-09-19T21:55:00Z'));
    liveMatch(1, [AMOUR]);
    noteInGameName(db, AMOUR, 'practice name', null, new Date('2026-09-19T22:30:00Z'));
    complete(1, new Date('2026-09-19T23:00:00Z'));
    expect(names(AMOUR)).toEqual([]);
  });

  it('still takes a last name from the first moments of the match, as players load in', () => {
    db.prepare('UPDATE players SET avatar = NULL WHERE steamid = ?').run(AMOUR);
    liveMatch(1, [AMOUR]);
    noteInGameName(db, AMOUR, 'loading in', null, new Date('2026-09-19T22:01:00Z'));
    complete(1, new Date('2026-09-19T23:00:00Z'));
    expect(names(AMOUR)).toEqual([['loading in', 1]]);
  });

  it('ignores a last name older than the window', () => {
    noteInGameName(db, AMOUR, 'last week', null, new Date('2026-09-12T21:55:00Z'));
    liveMatch(1, [AMOUR]);
    complete(1, new Date('2026-09-19T23:00:00Z'));
    expect(names(AMOUR)).toEqual([['amour plastique', 1]]);
  });

  it('never counts an aborted match, and clears its scratch at the next fold', () => {
    liveMatch(1, [AMOUR]);
    noteInGameName(db, AMOUR, 'aborted name', 1);
    db.prepare("UPDATE matches SET state = 'aborted' WHERE id = 1").run();
    liveMatch(2, [OTHER]);
    complete(2, new Date('2026-09-20T23:00:00Z'));
    expect(names(AMOUR)).toEqual([]);
    expect((db.prepare('SELECT COUNT(*) AS n FROM match_name_sightings').get() as any).n).toBe(0);
  });

  it('shows the spelling used in the most matches', () => {
    for (const [id, spelling] of [[1, 'Amour'], [2, 'amour'], [3, 'amour']] as const) {
      liveMatch(id, [OTHER]);
      noteInGameName(db, OTHER, spelling, id);
      complete(id, new Date(`2026-09-2${id}T23:00:00Z`));
    }
    expect(names(OTHER)).toContainEqual(['amour', 3]);
  });
});

describe('the rename digest', () => {
  function play(id: number, steamid: string, name: string, day: number): void {
    liveMatch(id, [steamid]);
    noteInGameName(db, steamid, name, id);
    complete(id, new Date(`2026-09-${day}T23:00:00Z`));
  }

  it('queues nothing for a brand-new player, then the first new name after', () => {
    // A persona and an in-game name that differ on the first match are
    // both the new player's first names.
    db.prepare("UPDATE players SET name = 'amour p' WHERE steamid = ?").run(AMOUR);
    play(1, AMOUR, 'amour plastique', 19);
    expect(takeRenameDigest(db, new Date('2026-09-20T00:00:00Z'))).toBeNull();
    db.prepare("UPDATE players SET name = 'v' WHERE steamid = ?").run(AMOUR);
    play(2, AMOUR, 'v', 24);
    play(3, AMOUR, 'v', 24);
    const digest = takeRenameDigest(db, new Date('2026-09-25T00:00:00Z'));
    expect(digest).toEqual([{ steamid: AMOUR, chain: ['amour p', 'amour plastique', 'v'], earlier: 0 }]);
  });

  it('posts at most once a day, and holds what arrives in between', () => {
    play(1, AMOUR, 'amour plastique', 19);
    play(2, AMOUR, 'v', 20);
    expect(takeRenameDigest(db, new Date('2026-09-21T00:00:00Z'))).not.toBeNull();
    play(3, AMOUR, 'xX', 21);
    expect(takeRenameDigest(db, new Date('2026-09-21T12:00:00Z'))).toBeNull();
    expect(takeRenameDigest(db, new Date('2026-09-22T00:00:01Z'))?.[0].chain)
      .toEqual(['amour plastique', 'v', 'xX']);
    expect(takeRenameDigest(db, new Date('2026-09-24T00:00:00Z'))).toBeNull();
  });

  it('collects nothing while the setting is off', () => {
    setSetting(db, 'admin_feed_renames', '0');
    play(1, AMOUR, 'amour plastique', 19);
    play(2, AMOUR, 'v', 20);
    expect(takeRenameDigest(db, new Date('2026-09-21T00:00:00Z'))).toBeNull();
    setSetting(db, 'admin_feed_renames', '1');
    expect(takeRenameDigest(db, new Date('2026-09-21T00:00:00Z'))).toBeNull();
  });

  it('never queues from a backfill', () => {
    recordNameUses(db, AMOUR, 'log:a', [{ source: 'ingame', name: 'one' }], '2026-09-01 00:00:00', { queue: false });
    recordNameUses(db, AMOUR, 'log:b', [{ source: 'ingame', name: 'two' }], '2026-09-02 00:00:00', { queue: false });
    expect(takeRenameDigest(db, new Date('2026-09-21T00:00:00Z'))).toBeNull();
    expect(names(AMOUR)).toHaveLength(2);
  });
});

describe('aliases', () => {
  it('lands a merged alt\'s names on the main account', () => {
    upsertPlayer(db, { steamid: ALT, name: 'alt', avatar: null }, []);
    addAlias(db, { steamid: ALT, canonical: AMOUR, by: 'test' });
    liveMatch(1, [AMOUR]);
    noteInGameName(db, ALT, 'alt name', 1);
    complete(1, new Date('2026-09-19T23:00:00Z'));
    expect(names(AMOUR)).toContainEqual(['alt name', 1]);
    expect(names(ALT)).toEqual(names(AMOUR));
    expect(db.prepare('SELECT 1 FROM player_name_uses WHERE steamid = ?').get(ALT)).toBeUndefined();
  });
});

describe('alsoKnownAs', () => {
  const use = (key: string, name: string) =>
    recordNameUses(db, AMOUR, key, [{ source: 'ingame', name }], '2026-09-19 00:00:00', { queue: false });

  it('leaves out the current name and ranks by matches', () => {
    for (let i = 0; i < 12; i++) use(`m:${i}`, 'amour plastique');
    use('m:20', 'v');
    use('m:21', 'v');
    expect(alsoKnownAs(db, AMOUR, 'v')).toEqual([{ name: 'amour plastique', matches: 12 }]);
    expect(alsoKnownAs(db, AMOUR, 'someone new')).toEqual([
      { name: 'amour plastique', matches: 12 }, { name: 'v', matches: 2 },
    ]);
  });

  it('drops one-match names once there are more than fit', () => {
    use('m:1', 'a'); use('m:2', 'a');
    use('m:3', 'b');
    use('m:4', 'c');
    use('m:5', 'd');
    expect(alsoKnownAs(db, AMOUR, 'now')).toEqual([{ name: 'a', matches: 2 }]);
    // Three or fewer: nothing is hidden.
    expect(alsoKnownAs(db, AMOUR, 'now', 5).map((r) => r.name).sort()).toEqual(['a', 'b', 'c', 'd']);
  });
});
