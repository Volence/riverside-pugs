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

describe('HowToPlay queue alerts', () => {
  it('describes the alert as a standing opt-in, not a one-time request', () => {
    const { container } = render(<HowToPlay session={{ kind: 'anonymous' }} />);
    const text = container.textContent!;
    expect(text).toContain('Queue alerts (on/off)');
    expect(text).toMatch(/stays on until you turn it off/);
    expect(text).not.toContain('Notify me');
  });
});

// Content pass 2026-10-23: facts checked against settings and code.
describe('HowToPlay facts', () => {
  it('states the no-show ladder, the 7 minute no-show cancel and the abandon rating loss', () => {
    const { container } = render(<HowToPlay session={{ kind: 'anonymous' }} />);
    const text = container.textContent!;
    expect(text).toContain('1 hour, then 3 hours, then a day');
    expect(text).toContain('7 minutes after the server is ready');
    expect(text).toContain('You lose rating');
    expect(text).not.toMatch(/nobody's rating changes/);
  });

  it('lists the forfeit command and has the practice and events sections', () => {
    const { container } = render(<HowToPlay session={{ kind: 'anonymous' }} />);
    expect(container.textContent).toContain('!gg');
    expect(container.querySelector('#practice')).toBeTruthy();
    expect(container.querySelector('#events a[href="/events"]')).toBeTruthy();
  });
});
