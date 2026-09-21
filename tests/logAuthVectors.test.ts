import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { macOf } from '../src/logAuth.js';

/**
 * The plugins sign their log lines with an HMAC-SHA1 written in SourcePawn
 * (plugin/pug-hmac.inc), and the backend checks them with node:crypto. Two
 * implementations of one function, in two languages, on two machines: if they
 * ever disagree, every signed line fails and nothing says why.
 *
 * plugin/tests/logauth_vectors.sp holds ONE table of vectors. That program
 * checks the SourcePawn side against it inside a real SourcePawn VM (see
 * plugin/test-logauth.sh); this file checks the node side against the same
 * table, parsed out of the same source. Neither can drift without its half
 * failing.
 */
const SRC = readFileSync(new URL('../plugin/tests/logauth_vectors.sp', import.meta.url), 'utf8');
const SWEEP_KEY = '0123456789abcdef0123456789abcdef';

function stringVectors(): { key: string; msg: string; mac: string }[] {
  const out: { key: string; msg: string; mac: string }[] = [];
  const re = /^\t\{ "([^"\\]*)", "([^"\\]*)", "([0-9a-f]{40})" \},$/gm;
  for (const m of SRC.matchAll(re)) out.push({ key: m[1], msg: m[2], mac: m[3] });
  return out;
}

function sweepVectors(): { len: number; mac: string }[] {
  const lens = /g_iSweepLen\[\] = \{ ([0-9, ]+) \};/.exec(SRC)![1].split(',').map((s) => Number(s.trim()));
  const block = /g_sSweepMac\[\]\[41\] = \{\n([\s\S]*?)\n\};/.exec(SRC)![1];
  const macs = [...block.matchAll(/"([0-9a-f]{40})"/g)].map((m) => m[1]);
  expect(macs).toHaveLength(lens.length);
  return lens.map((len, i) => ({ len, mac: macs[i] }));
}

describe('HMAC-SHA1 vectors shared with plugin/pug-hmac.inc', () => {
  it('finds the tables', () => {
    expect(stringVectors().length).toBeGreaterThanOrEqual(8);
    expect(sweepVectors().length).toBeGreaterThanOrEqual(15);
    expect(SRC).toContain(`"${SWEEP_KEY}"`);
  });

  it('includes RFC 2202 test case 2, so the table itself is anchored to something outside this repo', () => {
    expect(stringVectors()).toContainEqual({
      key: 'Jefe', msg: 'what do ya want for nothing?', mac: 'effcdf6ae5eb2fa2d27416d5f184df9c259a7c79',
    });
  });

  it('node:crypto agrees with every string vector, as UTF-8 bytes', () => {
    for (const v of stringVectors()) {
      expect(createHmac('sha1', v.key).update(Buffer.from(v.msg, 'utf8')).digest('hex'), v.msg).toBe(v.mac);
    }
  });

  it('node:crypto agrees with every length in the sweep, high bytes and zero bytes included', () => {
    for (const v of sweepVectors()) {
      const msg = Buffer.from(Array.from({ length: v.len }, (_, j) => (j * 7 + 3) & 0xff));
      expect(createHmac('sha1', SWEEP_KEY).update(msg).digest('hex'), `len ${v.len}`).toBe(v.mac);
    }
  });

  it('macOf is the first four bytes of exactly that, keyed on the secret as text', () => {
    for (const v of stringVectors()) {
      expect(macOf(v.key, Buffer.from(v.msg, 'utf8'))).toBe(v.mac.slice(0, 8));
    }
  });
});
