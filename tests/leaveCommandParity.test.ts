import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** The plugin half of the abandon hold. Nothing here can run SourcePawn, so
 *  like the other parity tests this reads the source as text. It pins the
 *  properties the backend depends on and the ones that are easy to lose in an
 *  edit: the token check comes first, a hold on a connected player is refused
 *  while an add is not, nothing the caller typed is printed back, and the hold
 *  owns no timer (a TIMER_FLAG_NO_MAPCHANGE handle is freed at level shutdown,
 *  which is the trap OnMapEnd documents for g_hTeardown).
 *
 *  The first assertion of each block guards the extraction itself. */

const __dirname = dirname(fileURLToPath(import.meta.url));
const matchSrc = readFileSync(join(__dirname, '../plugin/pug-match.sp'), 'utf8');
const leaveSrc = readFileSync(join(__dirname, '../plugin/pug-leave.inc'), 'utf8');

/** The body of a top-level function, given its full signature line. */
function body(src: string, signature: string): string {
  const at = src.indexOf(`\n${signature}\n{\n`);
  if (at < 0) return '';
  const start = at + signature.length + 4;
  const end = src.indexOf('\n}\n', start);
  return end < 0 ? '' : src.slice(start, end);
}

/** The text of one verb's branch inside Cmd_Leave. */
function branch(cmd: string, verb: string, next: string | null): string {
  const from = cmd.indexOf(`StrEqual(verb, "${verb}")`);
  const to = next === null ? cmd.length : cmd.indexOf(`StrEqual(verb, "${next}")`);
  return from < 0 || to < 0 ? '' : cmd.slice(from, to);
}

describe('sm_pug_leave registration', () => {
  it('is a server command with the documented grammar', () => {
    expect(matchSrc).toContain(
      'RegServerCmd("sm_pug_leave", Cmd_Leave, "sm_pug_leave <token> <steamid64> hold|release|add <seconds>|end");',
    );
  });

  it('ships in 0.3.4', () => {
    expect(matchSrc).toContain('#define PLUGIN_VERSION "0.3.4"');
  });
});

describe('Cmd_Leave', () => {
  const cmd = body(leaveSrc, 'public Action Cmd_Leave(int args)');

  it('is found at all', () => {
    expect(cmd).toContain('GetCmdArg(3, verb, sizeof(verb));');
  });

  it('checks the token before anything else', () => {
    expect(cmd.trimStart().startsWith('if (!TokenArgOk(args)) return Plugin_Handled;')).toBe(true);
  });

  it('knows the four verbs', () => {
    for (const verb of ['hold', 'release', 'add', 'end']) expect(cmd).toContain(`StrEqual(verb, "${verb}")`);
  });

  it('refuses hold and end for a connected player, and allows add', () => {
    expect(branch(cmd, 'hold', 'release')).toContain('PUGERR not dropped');
    expect(branch(cmd, 'end', null)).toContain('PUGERR not dropped');
    expect(branch(cmd, 'add', 'end')).not.toContain('PUGERR not dropped');
  });

  it('never prints the caller\'s text back', () => {
    expect(cmd).not.toMatch(/PrintToServer\("PUGERR[^"]*%s/);
  });

  it('answers and echoes after every change', () => {
    expect(cmd).toContain('LeaveReply(slot);');
    expect(cmd).toContain('LeaveEmitState(slot, false);');
  });
});

describe('the hold itself', () => {
  it('spends nothing while held', () => {
    expect(body(leaveSrc, 'int LeaveRemaining(int slot)')).toContain('g_fHoldSince[slot] <= 0.0');
  });

  it('is cleared with the match, and by a return', () => {
    expect(body(leaveSrc, 'void LeaveReset()')).toContain('g_fHoldSince[i] = 0.0;');
    expect(body(leaveSrc, 'void LeaveOnReturn(int slot)')).toContain('g_fHoldSince[slot] = 0.0;');
  });

  it('has a ceiling that releases it and says so', () => {
    expect(leaveSrc).toContain('CreateConVar("sm_pug_leave_hold_max", "1800"');
    const clock = body(leaveSrc, 'public Action Timer_LeaveClock(Handle timer)');
    expect(clock).toContain('g_cvLeaveHoldMax.FloatValue');
    expect(clock).toContain('LeaveEmitState(i, true);');
  });

  it('owns no timer: the file still creates exactly the two it always did', () => {
    expect(leaveSrc.match(/CreateTimer\(/g)).toHaveLength(2);
  });

  it('keeps the STATUS line abandon.ts reads, and only appends to it', () => {
    expect(leaveSrc).toContain('DumpLine("STATUS leave abandoner=%s budget=%d autounpause=%d paused=%d holdmax=%d"');
  });
});
