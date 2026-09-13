import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent, act } from '@testing-library/preact';
import { Viewer, isDefaultCamera } from './Viewer';
import { FREE, TEAM } from './camera';
import { STATE, type Frame, type ReplayHeader } from '../../../src/replayFormat';

const HEADER: ReplayHeader = {
  version: 2, token: '', ordinal: 0, half: 1, playerHz: 10, entityHz: 2, map: 'not_a_real_map',
  startedUnix: 0, indexOffset: 0, indexCount: 0, frameCount: 0,
  slots: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'],
  infectedMask: 0,
  sidesKnown: false,
};
const NAMES = { A: 'bill', B: 'zoey', C: 'francis', D: 'louis', E: 'smk', F: 'boom', G: 'hunt', H: 'tank' };

function frames(): Frame[] {
  return [0, 100, 200].map((tMs) => ({
    tMs, offset: 0,
    players: Array.from({ length: 8 }, (_, slot) => ({
      slot, x: slot * 10, y: 0, z: 0, yaw: 0, pitch: 0,
      state: STATE.PRESENT | STATE.ALIVE,
      health: 100, temp: 0, cls: slot < 4 ? slot : 1, weapon: 0, clip: 0, reserve: 0,
    })),
    entities: [],
  }));
}

vi.mock('./source', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./source')>();
  return {
    ...actual,
    useReplaySource: () => ({ header: HEADER, frames: frames(), closed: true, tooNew: false, error: null }),
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.classList.remove('is-theater');
  // useToggles persists to localStorage; the second test turns two toggles off.
  localStorage.clear();
});

function mount() {
  // happy-dom has no 2D context. paint() returns early on a null context,
  // which is all this test needs of the canvas.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null as never);
  return render(
    <Viewer spec={{ kind: 'file', name: 'x' }} names={NAMES}
      timeline={[{ seq: 1, tMs: 100, kind: 'event', event: 'boom', actor: 'F', target: 'A', value: 0 }]} />,
  );
}

describe('Viewer theater', () => {
  it('enters theater from the chip, lays the roster down the edges in order, and leaves on Escape', () => {
    const { container } = mount();
    expect(container.querySelector('.replay--theater')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Theater' }));
    expect(container.querySelector('.replay--theater')).not.toBeNull();
    expect(container.querySelector('.hud-strip')).toBeNull();
    expect(container.querySelector('.tstat')).not.toBeNull();

    const left = [...container.querySelectorAll('.hud-edge--l .hudp__name')].map((n) => n.textContent);
    const right = [...container.querySelectorAll('.hud-edge--r .hudp__name')].map((n) => n.textContent);
    expect(left).toEqual(['bill', 'zoey', 'francis', 'louis']);
    expect(right).toEqual(['smk', 'boom', 'hunt', 'tank']);

    // Spec 7.1: follow is on by default in theater, on the survivor centroid.
    expect(screen.getByRole('button', { name: 'Survivors' }).classList.contains('is-on')).toBe(true);

    act(() => { fireEvent.keyDown(window, { key: 'Escape' }); });
    expect(container.querySelector('.replay--theater')).toBeNull();
    expect(container.querySelector('.hud-strip')).not.toBeNull();
    // And the camera is back where it was: free at fit.
    expect(screen.getByRole('button', { name: 'Free' }).classList.contains('is-on')).toBe(true);
    expect(screen.getByRole('button', { name: 'Zoom to fit' }).classList.contains('is-on')).toBe(true);
  });

  it('gives the rail its column and pushes the infected cards inward', () => {
    const { container } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Theater' }));
    const root = container.querySelector('.replay--theater') as HTMLElement;
    // Events and chat are on by default, so the rail is shown.
    expect(container.querySelector('.theater__rail')).not.toBeNull();
    expect(root.style.getPropertyValue('--rail-w')).toBe('320px');
    fireEvent.click(screen.getByRole('button', { name: 'Events' }));
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    expect(container.querySelector('.theater__rail')).toBeNull();
    expect(root.style.getPropertyValue('--rail-w')).toBe('0px');
  });

  it('leaves no interactive element inside the edge HUD plates for the stage to fight over pointer events', () => {
    const { container } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Theater' }));
    const edges = container.querySelectorAll('.hud-edge');
    expect(edges.length).toBeGreaterThan(0);
    expect(container.querySelectorAll('.hud-edge .hudp').length).toBeGreaterThan(0);
    for (const edge of edges) {
      expect(edge.querySelector('button, a, input')).toBeNull();
    }
  });
});

describe('isDefaultCamera', () => {
  it('is true within tolerance of fit and free, even after a zoom-in/zoom-out round trip', () => {
    expect(isDefaultCamera({ cam: { zoom: 1.0000000000000002, panX: 0, panY: 0 }, follow: FREE })).toBe(true);
  });

  it('is false when zoomed', () => {
    expect(isDefaultCamera({ cam: { zoom: 2, panX: 0, panY: 0 }, follow: FREE })).toBe(false);
  });

  it('is false when following, even at fit zoom', () => {
    expect(isDefaultCamera({ cam: { zoom: 1, panX: 0, panY: 0 }, follow: TEAM })).toBe(false);
  });
});
