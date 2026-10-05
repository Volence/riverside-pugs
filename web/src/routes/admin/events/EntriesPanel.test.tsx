import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { AdminEntryView } from '../../../api';

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { eventEntries: vi.fn(), openEventCheckin: vi.fn(), lockEventEntries: vi.fn(), reorderEventSeeds: vi.fn(), disqualifyEventEntry: vi.fn(), restoreEventEntry: vi.fn(), setEventEntryRoster: vi.fn() },
}));
vi.mock('../../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api')>();
  return { ...actual, adminApi: { ...actual.adminApi, ...mockAdmin } };
});
vi.mock('../../../components/Confirm', () => ({ confirm: vi.fn(async () => true) }));
const { EntriesPanel } = await import('./EntriesPanel');

const entry = (over: Partial<AdminEntryView> = {}): AdminEntryView => ({
  id: 1, teamSlug: 'rats', name: 'Rats', tag: 'RAT', status: 'registered', dropReason: null, seed: null, waitlist: null, sr: 1500,
  checkedInAt: null, createdAt: '2026-10-05T00:00:00.000Z', registeredByName: 'cap',
  roster: [{ steamid: '1', name: 'p1', avatar: null, role: 'starter', problems: ['Discord is not linked'] }], ...over,
});

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('EntriesPanel', () => {
  it('shows each entry with SR, problems and waitlist, and no controls for a mod', async () => {
    mockAdmin.eventEntries.mockResolvedValue({ lockedAt: null, entries: [entry(), entry({ id: 2, name: 'Bats', waitlist: 1 })] });
    render(<EntriesPanel eventId={9} status="registration" canEdit={false} />);
    expect(await screen.findByText('Rats')).toBeTruthy();
    expect(screen.getAllByText(/SR 1500/)).toHaveLength(2);
    // Both entries share the same default roster (and so the same problem text);
    // the brief's test used getByText, which throws on more than one match.
    expect(screen.getAllByText(/Discord is not linked/)).toHaveLength(2);
    expect(screen.getByText(/Waitlist 1/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('lets an admin close the entry list early and move a seed up', async () => {
    mockAdmin.eventEntries.mockResolvedValue({ lockedAt: null, entries: [entry()] });
    mockAdmin.lockEventEntries.mockResolvedValue({});
    render(<EntriesPanel eventId={9} status="checkin" canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'Close the entry list now' }));
    await waitFor(() => expect(mockAdmin.lockEventEntries).toHaveBeenCalledWith(9));

    cleanup();
    mockAdmin.eventEntries.mockResolvedValue({ lockedAt: 'x', entries: [entry({ seed: 1 }), entry({ id: 2, name: 'Bats', seed: 2 })] });
    mockAdmin.reorderEventSeeds.mockResolvedValue({});
    render(<EntriesPanel eventId={9} status="checkin" canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'Move Bats up' }));
    await waitFor(() => expect(mockAdmin.reorderEventSeeds).toHaveBeenCalledWith(9, [2, 1]));
  });

  it('keeps each row\'s Disqualify reason separate from every other row', async () => {
    mockAdmin.eventEntries.mockResolvedValue({ lockedAt: null, entries: [entry(), entry({ id: 2, name: 'Bats' })] });
    mockAdmin.disqualifyEventEntry.mockResolvedValue({});
    render(<EntriesPanel eventId={9} status="checkin" canEdit />);
    await screen.findByText('Rats');
    const [firstReason, secondReason] = screen.getAllByPlaceholderText('Reason');
    fireEvent.input(firstReason, { target: { value: 'Roster stacked' } });
    const [firstDisqualify] = screen.getAllByRole('button', { name: 'Disqualify' });
    fireEvent.click(firstDisqualify);
    await waitFor(() => expect(mockAdmin.disqualifyEventEntry).toHaveBeenCalledWith(9, 1, 'Roster stacked'));
    expect((secondReason as HTMLInputElement).value).toBe('');
  });

  it('hides the seed Up/Down controls once the event is live', async () => {
    mockAdmin.eventEntries.mockResolvedValue({ lockedAt: 'x', entries: [entry({ seed: 1 }), entry({ id: 2, name: 'Bats', seed: 2 })] });
    render(<EntriesPanel eventId={9} status="live" canEdit />);
    await screen.findByText(/Rats/);
    expect(screen.queryByRole('button', { name: 'Move Bats up' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Move .* down/ })).toBeNull();
  });
});
