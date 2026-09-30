import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/preact';
import type { QueueActivity } from '../api';

const { mockApi } = vi.hoisted(() => ({ mockApi: { activity: vi.fn() } }));
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, adminApi: { ...actual.adminApi, ...mockApi } };
});

const { ActivityPanel } = await import('./ActivityPanel');

function data(total: number, medianSec: number | null = null): QueueActivity {
  const pops = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  pops[3][1] = total;
  return {
    days: 28, pops, totalPops: total,
    waits: { medianSec, byHourSec: new Array(24).fill(null), popped: 0, left: 0, leftMedianSec: null },
  };
}

afterEach(cleanup);
beforeEach(() => mockApi.activity.mockReset());

describe('ActivityPanel', () => {
  it('draws a seven by twenty-four grid with the busiest window and the typical wait', async () => {
    mockApi.activity.mockResolvedValue(data(40, 6 * 60));
    const { container } = render(<ActivityPanel />);
    expect(await screen.findByText('When people play')).toBeTruthy();
    expect(container.querySelectorAll('.activity__cell')).toHaveLength(7 * 24);
    expect(container.querySelector('.activity__summary')?.textContent).toMatch(/Busiest from .+ to .+ your time\./);
    expect(container.querySelector('.activity__summary')?.textContent).toContain('about 6 minutes');
    // The one busy cell is fully shaded; an empty one is not.
    const shaded = [...container.querySelectorAll<HTMLElement>('.activity__cell')].filter((c) => c.style.getPropertyValue('--v') === '1.000');
    expect(shaded).toHaveLength(1);
  });

  it('says when no waits are recorded yet, and counts them once there are', async () => {
    mockApi.activity.mockResolvedValue(data(40));
    const { container, unmount } = render(<ActivityPanel />);
    await screen.findByText('When people play');
    expect(container.querySelector('.activity__waits')?.textContent).toContain('none yet');
    unmount();
    const d = data(40, 300);
    d.waits.popped = 12; d.waits.left = 3;
    mockApi.activity.mockResolvedValue(d);
    const second = render(<ActivityPanel />);
    await screen.findByText('When people play');
    const text = second.container.querySelector('.activity__waits')?.textContent ?? '';
    expect(text).toContain('12 queues reached a pop');
    expect(text).toContain('median wait 5 minutes');
    expect(text).toContain('3 left before one');
  });

  it('leaves the wait out until there is one', async () => {
    mockApi.activity.mockResolvedValue(data(40));
    const { container } = render(<ActivityPanel />);
    await screen.findByText('When people play');
    expect(container.querySelector('.activity__summary')?.textContent).not.toContain('to pop');
  });

  it('renders nothing on a site with too few games to say anything', async () => {
    mockApi.activity.mockResolvedValue(data(3));
    const { container } = render(<ActivityPanel />);
    await new Promise((r) => setTimeout(r, 0));
    expect(mockApi.activity).toHaveBeenCalled();
    expect(container.textContent).toBe('');
  });
});
