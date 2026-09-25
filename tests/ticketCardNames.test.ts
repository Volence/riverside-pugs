import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer } from '../src/players.js';
import { fileReport } from '../src/tickets/filing.js';
import { reportLine, ticketCard } from '../src/discord/ticketCard.js';

const IDS = Array.from({ length: 5 }, (_, i) => `7656119900000000${i}`);
const [GAIGE, OTHER, ZERO, HAPPY, ADMIN] = IDS;
const URL = 'https://pug.test';
let db: DB;

const file = (reporter: string, category: string, text: string) =>
  (fileReport(db, reporter, { targetId: ZERO, category, text }, { adminSteamIds: [ADMIN] }) as { ticketId: number; reportId: number });

beforeEach(() => {
  db = openDb(':memory:');
  ['gaige', 'other', 'zero', 'happy', 'admin'].forEach((name, i) => {
    upsertPlayer(db, { steamid: IDS[i], name, avatar: null }, []);
    activatePlayer(db, IDS[i]);
  });
});

describe('ticket card names the reporters', () => {
  it('shows each reporter, the category and what they wrote', () => {
    const { ticketId } = file(GAIGE, 'toxicity', 'Spamming slurs in queue vc');
    const card = ticketCard(db, ticketId, URL)!;
    const desc = card.payload.embeds[0].description ?? '';
    expect(desc).toContain('**gaige** · toxicity');
    expect(desc).toContain('> Spamming slurs in queue vc');
    expect(desc).not.toContain('Who reported');
  });

  it('escapes a reporter name and their text so neither can format or ping', () => {
    db.prepare('UPDATE players SET name = ? WHERE steamid = ?').run('**bold** @everyone', GAIGE);
    const { ticketId } = file(GAIGE, 'toxicity', '<@123> [x](https://evil.test)');
    const desc = ticketCard(db, ticketId, URL)!.payload.embeds[0].description ?? '';
    expect(desc).not.toContain('**bold**');
    expect(desc).not.toContain('](https://evil.test)');
    expect(ticketCard(db, ticketId, URL)!.payload.mentionUserIds).toEqual([]);
  });

  it('keeps the description under Discord\'s limit, newest reports kept', () => {
    const { ticketId } = file(GAIGE, 'toxicity', 'the first report');
    expect(ticketId).toBeGreaterThan(0);
    for (let i = 0; i < 14; i++) {
      db.prepare(`INSERT INTO ticket_reports (ticket_id, reporter_id, category, text, created_at) VALUES (?, ?, 'other', ?, '2026-01-01')`)
        .run(ticketId, OTHER, `report ${i} ${'c'.repeat(390)}`);
    }
    const desc = ticketCard(db, ticketId, URL)!.payload.embeds[0].description ?? '';
    expect(desc.length).toBeLessThanOrEqual(4096);
    expect(desc).toContain('report 13');
    expect(desc).toMatch(/\d+ earlier reports on the ticket page/);
    expect(desc).toContain('Bans are issued on the ticket page.');
  });

  it('says who closed it', () => {
    const { ticketId } = file(GAIGE, 'toxicity', 'x');
    db.prepare("UPDATE tickets SET status = 'closed', outcome = 'action_taken', closed_by = ?, closed_at = ? WHERE id = ?")
      .run(HAPPY, new Date().toISOString(), ticketId);
    const status = ticketCard(db, ticketId, URL)!.payload.embeds[0].fields!.find((f) => f.name === 'Status')!.value;
    expect(status).toBe('closed by happy: action taken');
  });

  it('a further report line names who filed it and what they wrote', () => {
    file(GAIGE, 'toxicity', 'first');
    const second = file(OTHER, 'griefing', 'threw the tank');
    const line = reportLine(db, second.reportId, URL).embeds[0];
    expect(line.title).toBe('Another report');
    expect(line.description).toContain('**other** · griefing');
    expect(line.description).toContain('> threw the tank');
  });
});
