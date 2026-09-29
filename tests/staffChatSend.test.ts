import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { listLines } from '../src/serverChat.js';
import { SendLimiter, cleanChatText, sendStaffChat, staffSayCommand } from '../src/staffChatSend.js';

const P = '76561199048276493';
const MOD = '76561199000000009';
const server = (db: DB, name: string): number => Number(db.prepare(
  "INSERT INTO servers (name, host, port, rcon_port, rcon_password, tv_port, tv_enabled) VALUES (?, '1.2.3.4', 27015, 27015, 'x', 27020, 1)",
).run(name).lastInsertRowid);

describe('cleanChatText', () => {
  it('turns quotes, semicolons and line breaks into spaces and trims', () => {
    expect(cleanChatText('hi"; quit\nnow', 190)).toBe('hi quit now');
    expect(cleanChatText('  a   b  ', 190)).toBe('a b');
  });
  it('caps the length after cleaning and returns empty for nothing left', () => {
    expect(cleanChatText('x'.repeat(300), 190)).toHaveLength(190);
    expect(cleanChatText(';;"\n', 190)).toBe('');
    expect(cleanChatText(42, 190)).toBe('');
  });
});

describe('SendLimiter', () => {
  it('allows 5 per 10 s per person', () => {
    const l = new SendLimiter();
    for (let i = 0; i < 5; i++) expect(l.allow(MOD, 1000 + i)).toBe(true);
    expect(l.allow(MOD, 2000)).toBe(false);
    expect(l.allow(P, 2000)).toBe(true);
    expect(l.allow(MOD, 11_001)).toBe(true);
  });
});

describe('staffSayCommand', () => {
  it('builds each target', () => {
    expect(staffSayCommand({ to: 'all' }, 'Volence', 'hello', 7)).toBe('sm_pug_staffsay all "Volence" "hello" 7');
    expect(staffSayCommand({ to: 'team', team: 2 }, 'V', 'go', 8)).toBe('sm_pug_staffsay survivors "V" "go" 8');
    expect(staffSayCommand({ to: 'team', team: 3 }, 'V', 'go', 9)).toBe('sm_pug_staffsay infected "V" "go" 9');
    expect(staffSayCommand({ to: 'team', team: 1 }, 'V', 'go', 10)).toBe('sm_pug_staffsay spectators "V" "go" 10');
    expect(staffSayCommand({ to: 'player', steamid: P }, 'V', 'psst', 11)).toBe(`sm_pug_staffsay ${P} "V" "psst" 11`);
  });
});

describe('sendStaffChat', () => {
  let db: DB;
  let sid: number;
  beforeEach(() => {
    db = openDb(':memory:');
    sid = server(db, 'Dallas');
  });

  it('stores the row first, then sends one command', async () => {
    const sent: string[][] = [];
    const r = await sendStaffChat(db, async (_s, cmds) => { sent.push(cmds); return ['']; }, {
      serverId: sid, sentBy: MOD, name: 'Volence', target: { to: 'player', steamid: P }, message: 'on it',
    });
    expect(r).toEqual({ ok: true, id: expect.any(Number) });
    expect(sent).toEqual([[`sm_pug_staffsay ${P} "Volence" "on it" ${r.id}`]]);
    expect(listLines(db, sid, 0, 10)[0]).toMatchObject({ kind: 'staff_out', to_kind: 'player', to_value: P, delivered: null });
  });

  it('an rcon failure marks the row -1 and says so', async () => {
    const r = await sendStaffChat(db, async () => { throw new Error('rcon connect timeout'); }, {
      serverId: sid, sentBy: MOD, name: 'V', target: { to: 'all' }, message: 'hi',
    });
    expect(r).toMatchObject({ ok: false, error: 'Could not reach the server.' });
    expect(listLines(db, sid, 0, 10)[0].delivered).toBe(-1);
  });

  it('an old plugin (Unknown command) marks -1 and names the version', async () => {
    const r = await sendStaffChat(db, async () => ['Unknown command "sm_pug_staffsay"'], {
      serverId: sid, sentBy: MOD, name: 'V', target: { to: 'all' }, message: 'hi',
    });
    expect(r).toMatchObject({ ok: false, error: 'This server needs pug-match 0.3.16 to send.' });
    expect(listLines(db, sid, 0, 10)[0].delivered).toBe(-1);
  });
});
