import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import { MIRROR_CAMPAIGN_PIECES, MirrorPack } from './MirrorPack';
import { MIRROR_CAMPAIGNS } from '../../../src/campaigns';

afterEach(cleanup);

describe('mirror pack downloads', () => {
  it('has one piece per mirror campaign, each with a real size', () => {
    expect(MIRROR_CAMPAIGN_PIECES).toHaveLength(Object.keys(MIRROR_CAMPAIGNS).length);
    const titles = new Set(Object.values(MIRROR_CAMPAIGNS).map((c) => c.name));
    for (const p of MIRROR_CAMPAIGN_PIECES) {
      expect(titles.has(p.note!)).toBe(true);
      expect(p.bytes).toBeGreaterThan(0);
    }
  });

  it('lists the shared files and every campaign, and points the L4D2 ones at the L4D2 pack', () => {
    render(<MirrorPack />);
    const rows = document.querySelectorAll('#mirror-pack .l4d2pick__row');
    expect(rows).toHaveLength(MIRROR_CAMPAIGN_PIECES.length + 1);
    expect(document.querySelector('#mirror-pack a[href="#l4d2-pack"]')).not.toBeNull();
  });
});
