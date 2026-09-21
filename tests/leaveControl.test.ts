import { describe, it, expect } from 'vitest';
import { isUnknownCommand, isUnknownCvar, leaveCommand, parseLeaveReply, OLD_PLUGIN_ERROR } from '../src/leaveControl.js';

const TOKEN = 'a'.repeat(32);
const ID = '76561199000000002';

describe('leaveCommand', () => {
  it('builds the four console lines', () => {
    expect(leaveCommand(TOKEN, ID, 'hold')).toBe(`sm_pug_leave ${TOKEN} ${ID} hold`);
    expect(leaveCommand(TOKEN, ID, 'release')).toBe(`sm_pug_leave ${TOKEN} ${ID} release`);
    expect(leaveCommand(TOKEN, ID, 'add', 300)).toBe(`sm_pug_leave ${TOKEN} ${ID} add 300`);
    expect(leaveCommand(TOKEN, ID, 'end')).toBe(`sm_pug_leave ${TOKEN} ${ID} end`);
  });

  it('refuses anything that could end the command early', () => {
    expect(() => leaveCommand('nope', ID, 'hold')).toThrow(/token/);
    expect(() => leaveCommand(TOKEN, `${ID}; quit`, 'hold')).toThrow(/steamid/);
    expect(() => leaveCommand(TOKEN, ID, 'add')).toThrow(/seconds/);
    expect(() => leaveCommand(TOKEN, ID, 'add', 0)).toThrow(/seconds/);
    expect(() => leaveCommand(TOKEN, ID, 'add', 3601)).toThrow(/seconds/);
    expect(() => leaveCommand(TOKEN, ID, 'add', 1.5)).toThrow(/seconds/);
  });
});

describe('parseLeaveReply', () => {
  it('reads a held player', () => {
    expect(parseLeaveReply(`PUGOK leave steamid=${ID} absent=1 remaining=200 held=1 hold_left=1800\n`)).toEqual({
      ok: true, line: `PUGOK leave steamid=${ID} absent=1 remaining=200 held=1 hold_left=1800`, steamid: ID,
      state: { absent: true, remaining: 200, held: true, holdLeft: 1800 },
    });
  });

  it('reads a connected player who was given time, with other console text around it', () => {
    const body = `L 09/21/2026 - 20:00:00: rcon from "1.2.3.4"\nPUGOK leave steamid=${ID} absent=0 remaining=600 held=0 hold_left=0\njunk`;
    expect(parseLeaveReply(body)).toMatchObject({ ok: true, state: { absent: false, remaining: 600, held: false, holdLeft: null } });
  });

  it('passes a refusal through in the plugin\'s words', () => {
    expect(parseLeaveReply('PUGERR not dropped\n')).toEqual({ ok: false, oldPlugin: false, error: 'not dropped' });
    expect(parseLeaveReply('PUGERR bad token')).toEqual({ ok: false, oldPlugin: false, error: 'bad token' });
  });

  it('knows a plugin older than 0.3.4 when it sees one', () => {
    expect(parseLeaveReply('Unknown command "sm_pug_leave"\n')).toEqual({ ok: false, oldPlugin: true, error: OLD_PLUGIN_ERROR });
    expect(isUnknownCommand('Unknown command "sm_pug_leave_hold_max"')).toBe(true);
    expect(isUnknownCommand('')).toBe(false);
  });

  it('assumes nothing from silence or from a half line', () => {
    expect(parseLeaveReply('')).toEqual({ ok: false, oldPlugin: false, error: 'no answer' });
    expect(parseLeaveReply(`PUGOK leave steamid=${ID} absent=1`)).toMatchObject({ ok: false, oldPlugin: false });
  });
});

describe('isUnknownCvar', () => {
  it('is true for the exact line', () => {
    expect(isUnknownCvar('Unknown command "sm_pug_leave_hold_max"', 'sm_pug_leave_hold_max')).toBe(true);
  });

  it('is true with extra surrounding console lines', () => {
    const body = 'L 09/21/2026 - 20:00:00: rcon from "1.2.3.4"\nUnknown command "sm_pug_leave_hold_max"\nsome other line';
    expect(isUnknownCvar(body, 'sm_pug_leave_hold_max')).toBe(true);
  });

  it('is false when the unknown command names something else', () => {
    expect(isUnknownCvar('Unknown command "sm_cvar"', 'sm_pug_leave_hold_max')).toBe(false);
  });

  it('is false for unrelated console noise mentioning "unknown command" about something else, mixed with other lines', () => {
    const body = 'some line\nUnknown command "sm_cvar"\nanother line';
    expect(isUnknownCvar(body, 'sm_pug_leave_hold_max')).toBe(false);
  });

  it('tolerates no quotes', () => {
    expect(isUnknownCvar('Unknown command sm_pug_leave_hold_max', 'sm_pug_leave_hold_max')).toBe(true);
  });

  it('matches case insensitively', () => {
    expect(isUnknownCvar('UNKNOWN COMMAND "SM_PUG_LEAVE_HOLD_MAX"', 'sm_pug_leave_hold_max')).toBe(true);
  });

  it('is false on an empty reply', () => {
    expect(isUnknownCvar('', 'sm_pug_leave_hold_max')).toBe(false);
  });
});
