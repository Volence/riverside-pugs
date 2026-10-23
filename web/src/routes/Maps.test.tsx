import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/preact';
import type { MapIndexRow, SeasonMultipliers } from '../api';

const { mockApi } = vi.hoisted(() => ({ mockApi: { maps: vi.fn() } }));
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: { ...actual.api, ...mockApi } };
});
const { Maps } = await import('./Maps');
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const rounds = { attempts: 10, fastestSec: 300, avgSec: 400, slowestSec: 500, survivalPct: 14, measured: 10 };
const row = (map: string, campaign: string): MapIndexRow => ({ map, campaign, display: null, played: 10, avgScore: 400, rounds });
const maps = [row('l4d_vs_smalltown03_ranchhouse', 'death_toll'), row('c2m1_highway', 'dark_carnival')];
const multipliers: SeasonMultipliers = {
  season: 'Season 1', basedOn: 'Season 0', min: 0.75, max: 1.75, minMatches: 50,
  maps: { l4d_vs_smalltown03_ranchhouse: { after: 1.75, before: 1.4, saferoomRate: 0.141, matches: 185, recalculated: true } },
};

describe('Maps multipliers', () => {
  it('explains the multipliers and shows the column only for a campaign that changed', async () => {
    mockApi.maps.mockResolvedValue({ maps, pool: [], multipliers });
    const { container } = render(<Maps />);
    expect(await screen.findByText('Score multipliers in Season 1')).toBeTruthy();
    expect(screen.getByText(/was 1\.40, 14% made it in Season 0/)).toBeTruthy();
    const heads = [...container.querySelectorAll('.campaign-table')].map((t) => t.querySelectorAll('th').length);
    expect(heads).toEqual([8, 7]);
  });

  it('shows nothing about multipliers before Season 1', async () => {
    mockApi.maps.mockResolvedValue({ maps, pool: [], multipliers: null });
    const { container } = render(<Maps />);
    await screen.findAllByText('400');
    expect(screen.queryByText(/Score multipliers/)).toBeNull();
    expect(container.querySelector('th[title^="Score multiplier"]')).toBeNull();
  });
});
