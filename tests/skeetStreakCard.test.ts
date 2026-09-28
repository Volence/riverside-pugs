import { describe, it, expect } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer } from '../src/players.js';
import { renderSkeetStreak, type SkeetStreakRow } from '../src/discord/skeetStreakCard.js';

const PID = 'STEAM_0:0:1';
const EMOJI = /\p{Extended_Pictographic}/u;

let db: DB; let matchId: number;

function setup(name: string): void {
  db = openDb(':memory:');
  upsertPlayer(db, { steamid: PID, name, avatar: null }, []);
  matchId = Number(db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (1, 'completed', 'no_mercy')").run().lastInsertRowid);
}

const row = (over: Partial<SkeetStreakRow> = {}): SkeetStreakRow => ({
  match_id: matchId, player_id: PID, map_ordinal: 3, half: 1, t_ms: 248080, count: 3, span_ms: 1700,
  message_id: null, posted_at: null, ...over,
});

describe('renderSkeetStreak', () => {
  it('renders a triple', () => {
    setup('VII');
    const p = renderSkeetStreak(db, row(), 'https://pug.test');
    expect(p.content).toBe(
      `**VII** hit a **triple skeet** in match ${matchId} on No Mercy, 3 skeets in 1.7 seconds. `
      + `[Watch it](<https://pug.test/match/${matchId}?ordinal=3&half=1&t=248080>)`,
    );
    expect(p.mentionUserIds).toEqual([]);
    expect(p.embeds).toEqual([]);
    expect(p.components).toEqual([]);
  });

  it('renders a quad', () => {
    setup('VII');
    const p = renderSkeetStreak(db, row({ count: 4, span_ms: 3200 }), 'https://pug.test');
    expect(p.content).toContain('hit a **quad skeet**');
    expect(p.content).toContain('4 skeets in 3.2 seconds');
  });

  it('renders a 5-or-more streak', () => {
    setup('VII');
    const p = renderSkeetStreak(db, row({ count: 5, span_ms: 4990 }), 'https://pug.test');
    expect(p.content).toContain('hit a **5-skeet streak**');
    expect(p.content).toContain('5 skeets in 5.0 seconds');
  });

  it('escapes a name with markdown and a mass-mention', () => {
    setup('**b**');
    const p1 = renderSkeetStreak(db, row(), 'https://pug.test');
    expect(p1.content).toContain('**\\*\\*b\\*\\***');

    setup('@everyone');
    const p2 = renderSkeetStreak(db, row(), 'https://pug.test');
    expect(p2.content).toContain('**\\@everyone**');
  });

  it('never contains an emoji', () => {
    setup('VII');
    const p = renderSkeetStreak(db, row({ count: 6, span_ms: 4200 }), 'https://pug.test');
    expect(EMOJI.test(p.content ?? '')).toBe(false);
  });

  it('links the exact replay moment, wrapped to suppress the embed preview', () => {
    setup('VII');
    const p = renderSkeetStreak(db, row({ map_ordinal: 2, half: 2, t_ms: 99999 }), 'https://pug.test');
    expect(p.content).toContain(`(<https://pug.test/match/${matchId}?ordinal=2&half=2&t=99999>)`);
  });
});
