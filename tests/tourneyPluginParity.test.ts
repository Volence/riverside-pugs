import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseLogDatagram } from '../src/logParse.js';

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
      'SUB by=%s out=%s in=%s map=%d',
    ]);
    // The call is a PUGCALL (no token prefix), built into `line` and signed by PugLog.
    expect(tourneySrc).toContain('PugLog("%s", line);');
    // Nothing in the module logs around the signing path.
    expect(tourneySrc).not.toMatch(/LogToGame\(/);
  });

  it('SUB, as Tourney_Sub emits it, parses as a sub request', () => {
    const fmt = emitFormats(tourneySrc).find((f) => f.startsWith('SUB '))!;
    expect(fmt).toBeDefined();
    expect(tourneySrc).toContain(`EmitPug("${fmt}", by, outId, inId, g_iMapCount);`);
    for (const map of [0, 2]) {
      expect(parseLogDatagram(emitPug(fmt, CAPTAIN, OUT, IN, map))).toEqual({
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
    const cases: [string, string, string, { on: boolean; by: string | null; cause: string }][] = [
      ['on', CAPTAIN, 'call', { on: true, by: CAPTAIN, cause: 'call' }],
      ['on', 'site', 'staff', { on: true, by: null, cause: 'staff' }],
      ['off', 'site', 'staff', { on: false, by: null, cause: 'staff' }],
      ['off', STAFF, 'staff', { on: false, by: STAFF, cause: 'staff' }],
      ['off', 'site', 'reset', { on: false, by: null, cause: 'reset' }],
    ];
    for (const [state, by, cause, want] of cases) {
      expect(parseLogDatagram(emitPug(fmt, state, by, cause))).toEqual({ kind: 'admin_pause', token: TOKEN, ...want });
    }
  });

  it('the !admin PUGCALL parses as an admin call with no target, the map named and the text last', () => {
    const m = /Format\(line, sizeof\(line\), "(PUGCALL [^"]*)"/.exec(tourneySrc);
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
