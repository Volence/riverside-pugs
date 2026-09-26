import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import { HowToPlay } from './HowToPlay';

afterEach(cleanup);

// The L4D2 campaigns moved to addon VPKs on the Custom campaigns page
// (2026-09-26). The old install (copy a left4dead_dlc4 folder over the game,
// edit gameinfo.txt) must not be offered here any more.
describe('HowToPlay L4D2 campaigns', () => {
  it('points at the Custom campaigns page instead of the old folder install', () => {
    const { container } = render(<HowToPlay session={{ kind: 'anonymous' }} />);
    const section = container.querySelector('#map-pack')!;
    expect(section.querySelector('a')!.getAttribute('href')).toBe('/custom-campaigns#l4d2-pack');
    const text = container.textContent!;
    expect(text).not.toMatch(/gameinfo\.txt|left4dead_dlc4|L4D2-Maps-for-L4D1/);
  });
});
