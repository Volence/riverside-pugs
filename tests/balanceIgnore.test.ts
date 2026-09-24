import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { addIgnored, effectiveIgnored, listIgnored, PLUGIN_FILE_RE, removeIgnored, siteIgnored, withEffectiveIgnored } from '../src/balanceIgnore.js';

describe('balanceIgnore', () => {
  it('merges knobs.json and the site list', () => {
    const db = openDb(':memory:');
    expect(addIgnored(db, ['b.smx', 'a.smx'], { reason: 'r', by: '1', now: '2026-09-24 00:00:00' })).toEqual(['b.smx', 'a.smx']);
    expect(addIgnored(db, ['a.smx'], { reason: 'r', by: '1', now: 'x' })).toEqual([]);
    expect(siteIgnored(db)).toEqual(['a.smx', 'b.smx']);
    expect(effectiveIgnored(db, ['c.smx', 'a.smx'])).toEqual(['a.smx', 'b.smx', 'c.smx']);
    expect(withEffectiveIgnored(db, { versionless: [], ignored: ['c.smx'] })).toEqual({ versionless: [], ignored: ['a.smx', 'b.smx', 'c.smx'] });
    expect(listIgnored(db, ['c.smx'])).toEqual([
      { file: 'a.smx', reason: 'r', addedBy: '1', addedAt: '2026-09-24 00:00:00', source: 'site' },
      { file: 'b.smx', reason: 'r', addedBy: '1', addedAt: '2026-09-24 00:00:00', source: 'site' },
      { file: 'c.smx', reason: '', addedBy: null, addedAt: null, source: 'knobs' },
    ]);
    expect(removeIgnored(db, 'a.smx')).toBe(true);
    expect(removeIgnored(db, 'a.smx')).toBe(false);
    expect(siteIgnored(db)).toEqual(['b.smx']);
  });

  it('accepts only plugin file names', () => {
    expect(PLUGIN_FILE_RE.test('l4d_tvwatch.smx')).toBe(true);
    expect(PLUGIN_FILE_RE.test('../x.smx')).toBe(false);
    expect(PLUGIN_FILE_RE.test('x.cfg')).toBe(false);
  });
});
