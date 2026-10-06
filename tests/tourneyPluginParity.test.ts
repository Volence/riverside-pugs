import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseLogDatagram } from '../src/logParse.js';
import { SUB_NOT_BETWEEN, adminPauseTook, parseSubReply } from '../src/events/series.js';
import { TOURNAMENT_RULE_CLEAR } from '../src/bookings/tournamentGames.js';

/** The plugin half of plan T3c's in-game lines (plugin/pug-tourney.inc,
 *  pug-match 0.3.25). Nothing here can run SourcePawn, so like the other
 *  parity tests this reads the source as text: every format string the new
 *  code logs is pulled out of the plugin, filled the way the plugin fills it,
 *  framed as a logaddress datagram (with the signature trailer PugLog adds)
 *  and parsed by src/logParse.ts. An edit to either side that breaks the
 *  grammar fails here.
 *
 *  The first assertion of each block guards the extraction itself. */

const __dirname = dirname(fileURLToPath(import.meta.url));
const tourneySrc = readFileSync(join(__dirname, '../plugin/pug-tourney.inc'), 'utf8');
const pauseSrc = readFileSync(join(__dirname, '../plugin/pug-pause.inc'), 'utf8');
const matchSrc = readFileSync(join(__dirname, '../plugin/pug-match.sp'), 'utf8');

const TOKEN = '0123456789abcdef0123456789abcdef';
const CAPTAIN = '76561198000000001';
const OUT = '76561198000000002';
const IN = '76561198000000003';
const STAFF = '76561198000000004';
const TRAILER = ' lseq=1790141171.12 mac=0a1b2c3d';

/** A logaddress datagram as srcds sends one: LogToGame's L-prefixed line. */
function framed(body: string): Buffer {
  const head = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x52]);
  return Buffer.concat([head, Buffer.from(`L 10/07/2026 - 21:04:05: ${body}\n`, 'utf8')]);
}

/** SourcePawn's Format for the conversions these lines use (%s, %d). */
function fill(fmt: string, ...args: (string | number)[]): string {
  let i = 0;
  const out = fmt.replace(/%[sd]/g, () => String(args[i++]));
  expect(i).toBe(args.length);
  return out;
}

/** What EmitPug sends: `PUG <token> <body>`, then PugLog's signature. */
function emitPug(fmt: string, ...args: (string | number)[]): Buffer {
  return framed(`PUG ${TOKEN} ${fill(fmt, ...args)}${TRAILER}`);
}

/** Every string literal handed to EmitPug( in a source. */
function emitFormats(src: string): string[] {
  return [...src.matchAll(/EmitPug\("((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
}

describe('pug-tourney.inc log lines', () => {
  it('sends exactly the SUB and ADMINPAUSE lines through EmitPug, and the call through PugLog', () => {
    expect(emitFormats(tourneySrc).sort()).toEqual([
      'ADMINPAUSE state=%s by=%s cause=%s',
      'SUB by=%s out=%s in=%s map=%d%s',
    ]);
    // The call is a PUGCALL (no token prefix), built into `line` and signed by PugLog.
    expect(tourneySrc).toContain('PugLog("%s", line);');
    // Nothing in the module logs around the signing path.
    expect(tourneySrc).not.toMatch(/LogToGame\(/);
  });

  it('SUB, as Tourney_Sub emits it, parses as a sub request', () => {
    const fmt = emitFormats(tourneySrc).find((f) => f.startsWith('SUB '))!;
    expect(fmt).toBeDefined();
    // The tail is "" between chapters and " emergency=1" for a mid-chapter
    // sub of a disconnected player (0.3.26, plan T5).
    expect(tourneySrc).toContain(`EmitPug("${fmt}", by, outId, inId, g_iMapCount, emergency ? " emergency=1" : "");`);
    for (const map of [0, 2]) {
      expect(parseLogDatagram(emitPug(fmt, CAPTAIN, OUT, IN, map, ''))).toEqual({
        kind: 'sub_request', token: TOKEN, by: CAPTAIN, out: OUT, in: IN, map,
      });
      expect(parseLogDatagram(emitPug(fmt, CAPTAIN, OUT, IN, map, ' emergency=1'))).toMatchObject({
        kind: 'sub_request', token: TOKEN, by: CAPTAIN, out: OUT, in: IN, map,
      });
    }
  });

  it('ADMINPAUSE, for every by/cause the module passes, parses as an admin pause', () => {
    const fmt = emitFormats(tourneySrc).find((f) => f.startsWith('ADMINPAUSE '))!;
    expect(fmt).toBeDefined();
    expect(tourneySrc).toContain(`EmitPug("${fmt}", on ? "on" : "off", by, cause);`);
    // The call sites the module has, with the by= and cause= each one passes.
    expect(tourneySrc).toContain('Tourney_Freeze(id, "call");');          // !admin from a player
    expect(tourneySrc).toContain('Tourney_Freeze("site", "staff");');     // sm_pug_adminpause on
    expect(tourneySrc).toContain('Tourney_Lift("site", "staff", who);');  // sm_pug_adminpause off
    expect(tourneySrc).toContain('Tourney_Lift(id, "staff", name);');     // !lift / sm_pug_lift (id, or "site" unverified)
    expect(tourneySrc).toContain('Tourney_Lift("site", "reset", "");');   // ResetMatchState
    expect(matchSrc).toContain('Tourney_Lift("site", "reset", "");');     // sm_pug_abort
    expect(tourneySrc).toContain('Tourney_Lift(id, "forced", name, false);'); // an admin's !forceunpause while frozen
    const cases: [string, string, string, { on: boolean; by: string | null; cause: string }][] = [
      ['on', CAPTAIN, 'call', { on: true, by: CAPTAIN, cause: 'call' }],
      ['on', 'site', 'staff', { on: true, by: null, cause: 'staff' }],
      ['off', 'site', 'staff', { on: false, by: null, cause: 'staff' }],
      ['off', STAFF, 'staff', { on: false, by: STAFF, cause: 'staff' }],
      ['off', 'site', 'reset', { on: false, by: null, cause: 'reset' }],
      // cause=forced (an admin's !forceunpause) keeps its own cause (plan T3c Task 6).
      ['off', STAFF, 'forced', { on: false, by: STAFF, cause: 'forced' }],
      ['off', 'site', 'forced', { on: false, by: null, cause: 'forced' }],
    ];
    for (const [state, by, cause, want] of cases) {
      expect(parseLogDatagram(emitPug(fmt, state, by, cause))).toEqual({ kind: 'admin_pause', token: TOKEN, ...want });
    }
  });

  it('the !admin PUGCALL parses as an admin call with no target, the map named and the text last', () => {
    // The !admin call's line; !flag (plan T5) formats its own reason=tech PUGCALL in the same file.
    const m = /Format\(line, sizeof\(line\), "(PUGCALL [^"]*reason=admin[^"]*)"/.exec(tourneySrc);
    expect(m).not.toBeNull();
    const fmt = m![1];
    expect(fmt).toBe('PUGCALL steamid=%s target=none tteam=%d reason=admin match=%d ord=%d half=%d tms=%d via=game map=%s text=%s');
    const line = (text: string) => framed(`${fill(fmt, CAPTAIN, 2, 42, 3, 2, 61234, 'l4d_vs_hospital02_subway', text)}${TRAILER}`);
    expect(parseLogDatagram(line('they are stuck in the wall'))).toEqual({
      kind: 'call', steamid: CAPTAIN, target: 'none', callerTeam: 2, reason: 'admin',
      matchId: 42, ordinal: 3, half: 2, tMs: 61234, via: 'game', map: 'l4d_vs_hospital02_subway',
      text: 'they are stuck in the wall',
    });
    // A bare !admin (no reason typed) still reaches the site.
    expect(parseLogDatagram(line(''))).toMatchObject({ kind: 'call', reason: 'admin', text: '' });
    // Text that looks like fields never moves the call.
    expect(parseLogDatagram(line(`x steamid=${OUT} reason=cheating target=${OUT}`)))
      .toMatchObject({ steamid: CAPTAIN, reason: 'admin', target: 'none' });
  });
});

describe('pug-pause.inc while the staff freeze holds', () => {
  it('a paused PHASE or HEARTBEAT carries admin=1 before by=, and the site reads it', () => {
    const base = /Format\(out, len, "(%s=%s team=%d limit=%d leave=%d)"/.exec(pauseSrc);
    expect(base).not.toBeNull();
    expect(pauseSrc).toContain('if (TourneyFrozen()) Format(out, len, "%s admin=1", out);');
    const at = pauseSrc.indexOf('"%s admin=1"');
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(pauseSrc.indexOf('"%s by=%s"'));
    const fields = `${fill(base![1], 'state', 'paused', 0, 120, 0)} admin=1`;
    expect(emitFormats(pauseSrc)).toContain('PHASE %s');
    expect(emitFormats(matchSrc)).toContain('HEARTBEAT %s');
    expect(parseLogDatagram(emitPug('PHASE %s', fields))).toMatchObject({
      kind: 'phase', phase: { state: 'paused', team: null, admin: true },
    });
    // HEARTBEAT names the state with the key `phase` (pug-match.sp PhaseFields("phase", ...)).
    expect(matchSrc).toContain('PhaseFields("phase", fields, sizeof(fields));');
    expect(pauseSrc).toContain('PhaseFields("state", fields, sizeof(fields));');
    const hb = `${fill(base![1], 'phase', 'paused', 0, 120, 0)} admin=1`;
    expect(parseLogDatagram(emitPug('HEARTBEAT %s', hb))).toMatchObject({
      kind: 'heartbeat', phase: { state: 'paused', admin: true },
    });
    // A team's pause the freeze holds keeps its owner and by= after admin=1.
    const held = `${fill(base![1], 'state', 'paused', 1, 120, 0)} admin=1 by=${CAPTAIN}`;
    expect(parseLogDatagram(emitPug('PHASE %s', held))).toMatchObject({
      phase: { state: 'paused', team: 'a', admin: true, by: CAPTAIN },
    });
  });
});

describe('sm_pug_sub and sm_pug_adminpause', () => {
  it('are token-checked server commands with the documented grammar, in 0.3.25 or later', () => {
    expect(tourneySrc).toContain('RegServerCmd("sm_pug_sub", Cmd_PugSub,');
    expect(tourneySrc).toContain('RegServerCmd("sm_pug_adminpause", Cmd_AdminPause,');
    expect(tourneySrc).toContain('RegAdminCmd("sm_pug_lift", Cmd_Lift, ADMFLAG_GENERIC,');
    for (const fn of ['public Action Cmd_PugSub(int args)', 'public Action Cmd_AdminPause(int args)']) {
      const at = tourneySrc.indexOf(`${fn}\n{\n`);
      expect(at).toBeGreaterThan(0);
      expect(tourneySrc.slice(at + fn.length + 3).trimStart().startsWith('if (!TokenArgOk(args)) return Plugin_Handled;')).toBe(true);
    }
    const v = /#define PLUGIN_VERSION "0\.3\.(\d+)"/.exec(matchSrc);
    expect(v).not.toBeNull();
    expect(Number(v![1])).toBeGreaterThanOrEqual(25);
  });
});

/** The rcon answers the series engine reads (src/events/series.ts), from the
 *  plugin's own PrintToServer formats (plan T3c ledger). */
describe('pug-tourney.inc rcon answers', () => {
  const printed = [...tourneySrc.matchAll(/PrintToServer\("((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
  it('answers sm_pug_sub in the shapes parseSubReply reads', () => {
    expect(printed).toContain('PUGOK sub out=%s in=%s slot=%d');
    expect(printed).toContain('PUGOK sub already');
    expect(printed).toContain(`PUGERR ${SUB_NOT_BETWEEN}`);
    expect(parseSubReply(`${fill('PUGOK sub out=%s in=%s slot=%d', OUT, IN, 5)}\n`, OUT, IN)).toEqual({ ok: true, already: false });
    expect(parseSubReply('PUGOK sub already\n', OUT, IN)).toEqual({ ok: true, already: true });
    for (const err of printed.filter((p) => p.startsWith('PUGERR ') && !p.includes('%'))) {
      expect(parseSubReply(`${err}\n`, OUT, IN)).toEqual({ ok: false, error: err.slice('PUGERR '.length) });
    }
  });
  it('answers sm_pug_adminpause in the shape adminPauseTook reads', () => {
    const fmt = printed.find((p) => p.startsWith('PUGOK adminpause='));
    expect(fmt).toBe('PUGOK adminpause=%s frozen=%d');
    expect(adminPauseTook(fill(fmt!, 'on', 1), true)).toBe(true);
    expect(adminPauseTook(fill(fmt!, 'off', 0), false)).toBe(true);
    expect(adminPauseTook(fill(fmt!, 'on', 0), true)).toBe(false);
    expect(adminPauseTook('PUGERR adminpause state is on or off', true)).toBe(false);
  });
});

describe('pug-pause.inc technical pause end (plan T5 fix rounds 1 and 2)', () => {
  /** The body of one SourcePawn function, from its signature to the closing brace at column 0. */
  const body = (src: string, sig: string): string => {
    const start = src.indexOf(sig);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = src.indexOf('\n}\n', start);
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end);
  };

  it('the calling team ends its technical pause only on a tournament box, unfrozen, still technical and with nobody away', () => {
    const fn = body(pauseSrc, 'bool Tech_OwnerReady(int client, int team)');
    expect(fn).toMatch(/!TourneyOn\(\)/);
    expect(fn).toMatch(/TourneyFrozen\(\)/);
    expect(fn).toMatch(/g_bPauseConverted\) return false;/);
    expect(fn).toMatch(/if \(LeaveAnyAbsent\(\)\)\s*\{[^}]*return false;/);
    expect(fn).toContain('g_bTechReleased || ');
    expect(fn).toContain('LeaveUnpauseNow();');
  });

  it('the ready listener is hooked and hands the owner team to Tech_OwnerReady', () => {
    expect(tourneySrc).toContain('AddCommandListener(Listener_TourneyUnpause, "sm_ready");');
    const fn = body(tourneySrc, 'public Action Listener_TourneyUnpause(int client, const char[] command, int argc)');
    expect(fn).toContain('Tech_OwnerReady(client, team)');
  });

  it("a staff member's ready under a freeze lifts it instead of unpausing past it (in-game run 2026-10-06)", () => {
    const fn = body(tourneySrc, 'public Action Listener_TourneyUnpause(int client, const char[] command, int argc)');
    const staff = fn.indexOf('if (Tourney_IsStaff(client))');
    expect(staff).toBeGreaterThan(-1);
    expect(fn.slice(staff, staff + 120)).toContain('Tourney_LiftFromGame(client);');
    expect(fn).not.toContain('if (Tourney_IsStaff(client)) return Plugin_Continue;');
  });

  it('a released technical pause is not charged or run over during the countdown', () => {
    const fn = body(pauseSrc, 'static void Tech_Tick()');
    expect(fn.indexOf('if (g_bTechReleased) return;')).toBeGreaterThan(-1);
    expect(fn.indexOf('if (g_bTechReleased) return;')).toBeLessThan(fn.indexOf('g_fTechUsed[team] += 1.0;'));
  });
});

describe('a forfeit closes the technical pause (final review I-1)', () => {
  const ggSrc = readFileSync(join(__dirname, '../plugin/pug-gg.inc'), 'utf8');
  const body = (src: string, sig: string): string => {
    const start = src.indexOf(sig);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = src.indexOf('\n}\n', start);
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end);
  };

  it('Gg_ForfeitAs calls Tech_CloseForForfeit before EndMatchNow', () => {
    const fn = body(ggSrc, 'void Gg_ForfeitAs(int team, const char[] why)');
    const close = fn.indexOf('Tech_CloseForForfeit();');
    expect(close).toBeGreaterThan(-1);
    expect(close).toBeLessThan(fn.indexOf('EndMatchNow("forfeit");'));
  });

  it('Tech_CloseForForfeit ends the record and clears the converted pause, the pending !tech and the release', () => {
    const fn = body(pauseSrc, 'void Tech_CloseForForfeit()');
    expect(pauseSrc).not.toContain('static void Tech_CloseForForfeit');
    expect(fn).toContain('Tech_End();');
    expect(fn).toMatch(/if \(g_bPauseConverted\)\s*\{\s*g_bPauseConverted = false;\s*g_iPauseOwner = 0;\s*\}/);
    expect(fn).toContain('g_iTechPendingTeam = 0;');
    expect(fn).toContain('g_bTechReleased = false;');
  });
});

describe('TOURNAMENT_RULE_CLEAR puts every rule cvar back to the plugin default', () => {
  const sources = ['pug-pause.inc', 'pug-leave.inc', 'pug-tourney.inc']
    .map((f) => readFileSync(join(__dirname, '../plugin', f), 'utf8'));
  const defaults = new Map<string, string>();
  for (const src of sources) {
    for (const m of src.matchAll(/CreateConVar\("(sm_pug_[a-z_]+)",\s*"([^"]*)"/g)) defaults.set(m[1], m[2]);
  }

  it('finds the cvars it compares', () => {
    expect(defaults.size).toBeGreaterThanOrEqual(TOURNAMENT_RULE_CLEAR.length);
  });

  it('each clear line names a plugin cvar and its CreateConVar default', () => {
    for (const line of TOURNAMENT_RULE_CLEAR) {
      const [name, value, ...rest] = line.split(' ');
      expect(rest).toEqual([]);
      expect(defaults.has(name), `${name} is not created in the plugin`).toBe(true);
      expect(value, name).toBe(defaults.get(name));
    }
  });
});
