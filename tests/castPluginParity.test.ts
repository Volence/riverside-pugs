import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseLogDatagram } from '../src/logParse.js';

/** Parity backstop for the caster studio's two plugin lines, LIVEHUD and
 *  TANKDONE (pug-match 0.3.20), in the family of roundEndParity.test.ts:
 *  the plugin's format string, filled with sample values, must parse into
 *  every field, so a key renamed on one side is a failing test rather than a
 *  card that quietly goes blank. Plus the two structural rules the review
 *  asked for: a world-killed tank still reports, and a pass never restarts
 *  the recap window. Regex over text, like its siblings. */

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, '../plugin/pug-match.sp'), 'utf8');
const TOKEN = 'f'.repeat(32);

function format(verb: string): string {
  const m = src.match(new RegExp(`EmitPug\\(\\s*"(${verb} [^"]*)"`));
  return m ? m[1]! : '';
}

/** Fill %d and %s in order with the given values. */
function fill(fmt: string, values: (string | number)[]): string {
  let i = 0;
  return fmt.replace(/%[ds]/g, () => String(values[i++]));
}

const datagram = (body: string) => Buffer.concat([
  Buffer.from([0xff, 0xff, 0xff, 0xff, 0x52]),
  Buffer.from(`L 07/30/2026 - 14:23:01: PUG ${TOKEN} ${body}\n`, 'utf8'),
]);

describe('caster studio plugin lines', () => {
  it('LIVEHUD as the plugin formats it parses into every field', () => {
    const fmt = format('LIVEHUD');
    expect(fmt).not.toBe('');
    const line = fill(fmt, [62, 74, 31, '76561198030413993:62:3:212']);
    expect(parseLogDatagram(datagram(line))).toEqual({
      kind: 'live_hud', token: TOKEN,
      line: { prog: 62, tank: 74, witch: 31, players: [{ steamid: '76561198030413993', flow: 62, items: 3, dmg: 212 }] },
    });
  });

  it('TANKDONE as the plugin formats it parses into every field', () => {
    const fmt = format('TANKDONE');
    expect(fmt).not.toBe('');
    const line = fill(fmt, [84, '76561198030413993', 312, 2, 1, '76561198030413994:4200']);
    expect(parseLogDatagram(datagram(line))).toEqual({
      kind: 'tank_done', token: TOKEN,
      recap: { aliveS: 84, controller: '76561198030413993', dealt: 312, tanks: 2, passes: 1, players: [{ steamid: '76561198030413994', dmg: 4200 }] },
    });
  });

  it('ends a tank recap before the player_death handler returns on a missing attacker', () => {
    const body = src.slice(src.indexOf('public void Event_PlayerDeath('));
    const end = body.indexOf('TankRecapEnd(victim)');
    const bail = body.indexOf('if (attacker <= 0 || victim <= 0) return;');
    expect(end).toBeGreaterThan(0);
    expect(bail).toBeGreaterThan(0);
    expect(end).toBeLessThan(bail);
  });

  it('keeps an open recap window across a tank_spawn (a pass)', () => {
    const begin = src.slice(src.indexOf('void TankRecapBegin()'));
    const body = begin.slice(0, begin.indexOf('\n}\n'));
    // The open-window branch returns before the snapshot is retaken.
    const open = body.indexOf('if (g_fTankSpawnedAt > 0.0)');
    const snapshot = body.indexOf('g_iTankDmgAtSpawn[i] =');
    expect(open).toBeGreaterThan(0);
    expect(open).toBeLessThan(snapshot);
    expect(body.slice(open, snapshot)).toContain('return;');
  });
});
