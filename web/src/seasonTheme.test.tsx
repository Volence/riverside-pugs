import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/preact';

const { mockApi } = vi.hoisted(() => ({
  mockApi: { site: vi.fn(async () => ({ discordEnabled: false, discordInviteUrl: null, requireDiscord: false, season: null, duoQueue: true })) },
}));
vi.mock('./api', async (orig) => ({ ...(await orig<Record<string, unknown>>()), api: mockApi }));
const { useDuoQueueOn, useSeasonLook } = await import('./seasonTheme');

function Probe() {
  const on = useDuoQueueOn();
  useSeasonLook();
  return <span>{on ? 'duo on' : 'duo off'}</span>;
}

describe('useDuoQueueOn', () => {
  // Shares the season look's one /api/site request rather than making its own.
  it('reads duoQueue from the shared /api/site fetch', async () => {
    render(<Probe />);
    await waitFor(() => expect(screen.getByText('duo on')).toBeTruthy());
    expect(mockApi.site).toHaveBeenCalledTimes(1);
  });
});
