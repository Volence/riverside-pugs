import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import type { SteamAccount } from '../../api';
import type { Run } from './useAction';

const { mockAdmin } = vi.hoisted(() => ({ mockAdmin: { steamRefresh: vi.fn() } }));

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return { ...actual, adminApi: { ...actual.adminApi, ...mockAdmin } };
});

const { SteamAccountPanel } = await import('./SteamAccountPanel');

afterEach(cleanup);
beforeEach(() => { mockAdmin.steamRefresh.mockReset(); mockAdmin.steamRefresh.mockResolvedValue({ ok: true, refreshed: 1 }); });

// Isolated from useAction's confirm dialog: none of this panel's own calls
// ask first, so a plain run is enough to exercise it.
const run: Run = async (fn) => { await fn(); };

const account = (over: Partial<SteamAccount> = {}): SteamAccount => ({
  checkedAt: '2026-09-21T10:00:00.000Z', createdAt: '2026-08-22T00:00:00.000Z', ageDays: 30,
  reference: { kind: 'first_match', at: '2026-09-02T00:00:00.000Z' }, daysBeforeReference: 11,
  visibility: 'public', profileConfigured: true,
  bans: { vac: 1, game: 0, daysSinceLast: 105, community: false, economy: 'none', checkedAt: '2026-09-21T10:00:00.000Z' },
  l4d1: { state: 'visible', hours: 12 }, level: 3,
  lender: { steamid: '99', seenAt: '2026-09-20T20:00:00.000Z', player: { steamid: '99', name: 'lenny', banned: true } },
  flags: [
    { kind: 'new_account', text: 'New account: created 11 days before their first match here. New players are also new accounts.' },
    { kind: 'borrowed_game', text: 'Borrowed game: last seen playing on a copy shared by lenny through Steam Family Sharing. lenny is banned here.' },
  ],
  ...over,
});

describe('SteamAccountPanel', () => {
  it('shows the Steam account as context: age, bans, hours, level and the lender, and lets a caller open it', async () => {
    const onSelect = vi.fn();
    render(<SteamAccountPanel d={{ steamid: '2', steamAccount: account() }} busy={false} run={run} onSelect={onSelect} />);
    const section = document.getElementById('steam-account')!;
    const text = section.textContent ?? '';
    expect(text).toContain('not a verdict');
    expect(text).toContain('New account: created 11 days before their first match here.');
    expect(text).toContain('30 days old');
    expect(text).toContain('created 11 days before their first match here');
    expect(text).toContain('1 VAC ban');
    expect(text).toContain('105 days ago');
    expect(text).toContain('12 h');
    expect(text).toContain('Public');
    expect(text).toContain('Level 3');
    expect(text).toContain('BANNED here');
    expect(within(section).getByRole('link', { name: 'Steam profile' }).getAttribute('href'))
      .toBe('https://steamcommunity.com/profiles/2');

    fireEvent.click(within(section).getByRole('button', { name: 'lenny' }));
    expect(onSelect).toHaveBeenCalledWith('99');
  });

  it('says hidden rather than zero for a private profile, and unknown lenders by id', () => {
    render(<SteamAccountPanel
      d={{
        steamid: '2',
        steamAccount: account({
          createdAt: null, ageDays: null, reference: null, daysBeforeReference: null,
          visibility: 'private',
          bans: { vac: 0, game: 0, daysSinceLast: null, community: false, economy: 'none', checkedAt: '2026-09-21T10:00:00.000Z' },
          l4d1: { state: 'hidden', lastSeenHours: 4 }, level: null,
          lender: { steamid: '76561198000000099', seenAt: '2026-09-20T20:00:00.000Z', player: null },
          flags: [{ kind: 'private_profile', text: 'Private profile: Steam will not show this account\'s age, hours or level. Plenty of people keep it that way.' }],
        }),
      }}
      busy={false} run={run} onSelect={() => {}}
    />);
    const section = document.getElementById('steam-account')!;
    const text = section.textContent ?? '';
    expect(text).toContain('hidden (4 h when last visible)');
    expect(text).toContain('Private');
    expect(text).toContain('No VAC or game bans');
    expect(text).not.toMatch(/\b0 h\b/);
    expect(within(section).getByRole('link', { name: '76561198000000099' }).getAttribute('href'))
      .toBe('https://steamcommunity.com/profiles/76561198000000099');
  });

  it('says Steam has not been asked yet, and asks on request', async () => {
    render(<SteamAccountPanel d={{ steamid: '2', steamAccount: null }} busy={false} run={run} onSelect={() => {}} />);
    const section = document.getElementById('steam-account')!;
    expect(section.textContent).toContain('Steam has not been asked about this account yet');
    fireEvent.click(within(section).getByRole('button', { name: 'Check now' }));
    await waitFor(() => expect(mockAdmin.steamRefresh).toHaveBeenCalledWith('2'));
  });

  it('hides Check now for a viewer who may not call steam-refresh', () => {
    render(<SteamAccountPanel d={{ steamid: '2', steamAccount: null }} busy={false} run={run} onSelect={() => {}} canRefresh={false} />);
    expect(screen.queryByRole('button', { name: 'Check now' })).toBeNull();
  });
});
