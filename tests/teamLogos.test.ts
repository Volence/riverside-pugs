import { describe, it, expect } from 'vitest';
import { mkdtempSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { CommunityStore } from '../src/community/store.js';
import { checkLogo, LOGO_MAX_BYTES } from '../src/community/validate.js';
import { sweepCommunity, ORPHAN_GRACE_MS } from '../src/community/sweep.js';
import { png } from './pngFixture.js';

describe('checkLogo', () => {
  it('takes a 256 x 256 PNG and nothing else', () => {
    expect(checkLogo(png(256, 256))).toEqual({ ok: true, value: { w: 256, h: 256 } });
    expect(checkLogo(png(128, 128)).ok).toBe(false);
    expect(checkLogo(Buffer.from('GIF89a not a png')).ok).toBe(false);
    expect(checkLogo(Buffer.alloc(LOGO_MAX_BYTES + 1)).ok).toBe(false);
  });
});

describe('logo files', () => {
  it('are content addressed, read back, and survive the sweep only while a team uses them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'logos-'));
    const store = new CommunityStore({ dir, maxBytes: () => 1e9, freeBytes: async () => 1e12 });
    const used = store.putLogo(png(256, 256));
    const spare = store.putLogo(png(256, 255).subarray(0)); // a different file, unreferenced
    expect(store.readLogo(used.name)?.length).toBeGreaterThan(0);

    const db = openDb(':memory:');
    db.prepare("INSERT INTO players (steamid, name) VALUES ('76561199000000001', 'a')").run();
    db.prepare(`INSERT INTO teams (name, name_key, tag, tag_key, slug, captain_steamid, created_by, logo_key)
      VALUES ('Rats', 'rats', 'RR', 'RR', 'rats', '76561199000000001', '76561199000000001', ?)`).run(used.name);

    // Age both files past the grace period.
    const old = (Date.now() - ORPHAN_GRACE_MS - 60_000) / 1000;
    for (const f of store.list('logo')) utimesSync(f.file, old, old);
    sweepCommunity(db, store, new Date());
    expect(store.readLogo(used.name)).not.toBeNull();
    expect(store.readLogo(spare.name)).toBeNull();
  });
});
