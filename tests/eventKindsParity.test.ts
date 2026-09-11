import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { eventKindKeys } from '../src/eventKinds.js';

/** Parity backstop between plugin/pug-match.sp and src/eventKinds.ts.
 *
 *  Same hazard as tests/statKeysParity.test.ts. A kind the plugin emits that
 *  the registry does not know is an event the UI cannot label; a kind in the
 *  registry that the plugin never emits is a promise the feed does not keep.
 *  The first is a real bug and is asserted here. The second is allowed,
 *  because a kind may legitimately land ahead of its hook.
 *
 *  Parsing is deliberately simple regex-over-text. If the plugin's shape
 *  changes enough that the regex stops matching, the explicit non-zero
 *  assertion turns that into a loud failure rather than a vacuous pass. */

const __dirname = dirname(fileURLToPath(import.meta.url));
// pug-stats.inc is #include'd into pug-match.sp and carries its own EmitEvent
// call sites (e.g. "dp", from the deadly-pounce detector). Scanning
// pug-match.sp alone silently blind-spots every kind literal that lives in
// the include, which is exactly the failure mode this test exists to catch.
const pluginSrc = readFileSync(join(__dirname, '../plugin/pug-match.sp'), 'utf8')
  + readFileSync(join(__dirname, '../plugin/pug-stats.inc'), 'utf8');

/** Every literal passed as `kind` to the plugin's event emitters.
 *
 *  Matches EmitEvent AND EmitClientEvent. Note that "EmitClientEvent(" does
 *  not contain the substring "EmitEvent(", so a regex anchored on the bare
 *  name silently matches nothing in the client-resolved handlers. */
function emittedKinds(src: string): string[] {
  const calls = src.match(/Emit(?:Client)?Event\s*\(\s*"([a-z_]{1,24})"/g) ?? [];
  return [...new Set(calls.map((c) => c.replace(/.*"([a-z_]+)".*/, '$1')))];
}

describe('event kind parity', () => {
  it('finds event emissions in the plugin', () => {
    expect(emittedKinds(pluginSrc).length).toBeGreaterThan(0);
  });

  it('emits no kind the registry does not know', () => {
    const known = new Set(eventKindKeys());
    const unknown = emittedKinds(pluginSrc).filter((k) => !known.has(k));
    expect(unknown).toEqual([]);
  });

  it('emits every kind the registry promises except the ones explicitly deferred', () => {
    // `skeet` and `boom` come from skill_detect forwards rather than from a
    // pug-match hook, and are emitted in pug-stats.inc. Everything else must
    // have an emission site here, or the registry is advertising a feed the
    // plugin does not produce.
    const deferred = new Set(['skeet', 'boom']);
    const emitted = new Set(emittedKinds(pluginSrc));
    const missing = eventKindKeys().filter((k) => !deferred.has(k) && !emitted.has(k));
    expect(missing).toEqual([]);
  });
});
