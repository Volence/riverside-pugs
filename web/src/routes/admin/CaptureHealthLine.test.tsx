import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/preact';
import { CaptureHealthLine } from './MatchPanels';

afterEach(cleanup);

describe('CaptureHealthLine', () => {
  it('says what the anti-cheat capture has seen, and says so when it is nothing', () => {
    render(<CaptureHealthLine health={{ bursts: 12, detections: 1, lilacFlags: 2, lastBurstAt: '2026-09-22T10:00:00.000Z', lastFlagAt: null, matchesWithBursts: 1, caps: 0 }} />);
    expect(screen.getByText(/12 input bursts across 1 match/)).toBeTruthy();
    cleanup();
    render(<CaptureHealthLine health={{ bursts: 0, detections: 0, lilacFlags: 0, lastBurstAt: null, lastFlagAt: null, matchesWithBursts: 0, caps: 0 }} />);
    expect(screen.getByText(/no input bursts captured yet/)).toBeTruthy();
  });
});
