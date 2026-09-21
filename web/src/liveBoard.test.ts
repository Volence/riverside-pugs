import { describe, it, expect, afterEach } from 'vitest';
import { countdown, countUp, liveFromUrl, reasonText, OLD_PLUGIN_REASON } from './liveBoard';

describe('countdown', () => {
  it('runs down from what the server said, by whole seconds since it said it', () => {
    expect(countdown(258, true, 0)).toBe(258);
    expect(countdown(258, true, 0.9)).toBe(258);
    expect(countdown(258, true, 12.4)).toBe(246);
  });

  it('stops at zero', () => {
    expect(countdown(5, true, 60)).toBe(0);
  });

  it('stands still while it is held', () => {
    expect(countdown(258, false, 40)).toBe(258);
  });

  it('is unknown when the server did not know', () => {
    expect(countdown(null, true, 10)).toBeNull();
  });
});

describe('countUp', () => {
  it('adds the seconds since the payload arrived', () => {
    expect(countUp(42, 0)).toBe(42);
    expect(countUp(42, 18.7)).toBe(60);
  });
});

describe('reasonText', () => {
  it('words a connect drop with the time it happened', () => {
    expect(reasonText({ kind: 'signon_drop', at: '2026-09-21T14:02:00.000Z' })).toMatch(/^rejected by the file check at \d/);
  });

  it('words voice, and says nothing when nothing is known', () => {
    expect(reasonText({ kind: 'not_in_voice' })).toBe('not in a voice channel');
    expect(reasonText(null)).toBe('');
  });
});

describe('liveFromUrl', () => {
  afterEach(() => history.replaceState(null, '', '/admin'));

  it('reads the match the admin feed linked to', () => {
    history.replaceState(null, '', '/admin?live=81');
    expect(liveFromUrl()).toBe(81);
  });

  it('is null for anything that is not a match id', () => {
    history.replaceState(null, '', '/admin?live=abc');
    expect(liveFromUrl()).toBeNull();
    history.replaceState(null, '', '/admin');
    expect(liveFromUrl()).toBeNull();
  });
});

describe('the old plugin reason', () => {
  it('names the version, so the fix is obvious', () => {
    expect(OLD_PLUGIN_REASON).toContain('0.3.4');
  });
});
