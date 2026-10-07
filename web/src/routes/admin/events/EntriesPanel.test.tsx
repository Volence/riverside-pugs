import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { AdminEntryView } from '../../../api';

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { eventEntries: vi.fn(), openEventCheckin: vi.fn(), lockEventEntries: vi.fn(), reorderEventSeeds: vi.fn(), disqualifyEventEntry: vi.fn(), restoreEventEntry: vi.fn(), setEventEntryRoster: vi.fn(), setEntryIdentity: vi.fn(), replaceEntryPlayer: vi.fn() },
}));
const { mockPeople } = vi.hoisted(() => ({ mockPeople: { people: vi.fn() } }));
vi.mock('../../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api')>();
  return { ...actual, adminApi: { ...actual.adminApi, ...mockAdmin }, peopleApi: { ...actual.peopleApi, ...mockPeople } };
});
vi.mock('../../../components/Confirm', () => ({ confirm: vi.fn(async () => true) }));
const { confirm } = await import('../../../components/Confirm');
const { EntriesPanel } = await import('./EntriesPanel');

const entry = (over: Partial<AdminEntryView> = {}): AdminEntryView => ({
  id: 1, teamSlug: 'rats', name: 'Rats', tag: 'RAT', status: 'registered', dropReason: null, seed: null, waitlist: null, sr: 1500,
  checkedInAt: null, createdAt: '2026-10-05T00:00:00.000Z', registeredByName: 'cap',
  roster: [{ steamid: '1', name: 'p1', avatar: null, role: 'starter', problems: ['Discord is not linked'] }], captainSteamid: null, ...over,
});
/** A draft entry: captain c0 and three more starters. */
const draftEntry = (over: Partial<AdminEntryView> = {}): AdminEntryView => entry({
  name: 'Team c0', tag: '', teamSlug: null, status: 'checked_in', seed: 1, captainSteamid: 'c0',
  roster: ['c0', 's1', 's2', 's3'].map((s) => ({ steamid: s, name: s, avatar: null, role: 'starter' as const, problems: [] })), ...over,
});

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('EntriesPanel', () => {
  it('shows each entry with SR, problems and waitlist, and no controls for a mod', async () => {
    mockAdmin.eventEntries.mockResolvedValue({ lockedAt: null, entries: [entry(), entry({ id: 2, name: 'Bats', waitlist: 1 })] });
    render(<EntriesPanel eventId={9} status="registration" checkin canEdit={false} />);
    expect(await screen.findByText('Rats')).toBeTruthy();
    expect(screen.getAllByText(/SR 1500/)).toHaveLength(2);
    // Both entries share the same default roster (and so the same problem text);
    // the brief's test used getByText, which throws on more than one match.
    expect(screen.getAllByText(/Discord is not linked/)).toHaveLength(2);
    expect(screen.getByText(/Waitlist 1/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows no check-in anywhere for a draft event entry', async () => {
    mockAdmin.eventEntries.mockResolvedValue({ lockedAt: 'x', entries: [entry({ status: 'checked_in', seed: 1, teamSlug: null })] });
    render(<EntriesPanel eventId={9} status="registration" checkin={false} draft canEdit={false} />);
    expect(await screen.findByText(/Rats/)).toBeTruthy();
    expect(screen.queryByText(/Checked in/)).toBeNull();
    expect(screen.queryByText(/check-in/i)).toBeNull();
  });

  it('a team event entry still shows Checked in', async () => {
    mockAdmin.eventEntries.mockResolvedValue({ lockedAt: null, entries: [entry({ status: 'checked_in' })] });
    render(<EntriesPanel eventId={9} status="registration" checkin canEdit={false} />);
    expect(await screen.findByText(/Checked in/)).toBeTruthy();
  });

  it('lets staff rename a draft entry', async () => {
    mockAdmin.eventEntries.mockResolvedValue({ lockedAt: 'x', entries: [entry({ teamSlug: null, status: 'checked_in' })] });
    mockAdmin.setEntryIdentity.mockResolvedValue({});
    render(<EntriesPanel eventId={9} status="registration" checkin={false} draft canEdit />);
    fireEvent.input(await screen.findByLabelText('Team name for Rats'), { target: { value: 'The Rats' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name for Rats' }));
    await waitFor(() => expect(mockAdmin.setEntryIdentity).toHaveBeenCalledWith(9, 1, { name: 'The Rats' }));
  });

  it('lets an admin close the entry list early and move a seed up', async () => {
    mockAdmin.eventEntries.mockResolvedValue({ lockedAt: null, entries: [entry()] });
    mockAdmin.lockEventEntries.mockResolvedValue({});
    render(<EntriesPanel eventId={9} status="checkin" checkin canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'Close the entry list now' }));
    await waitFor(() => expect(mockAdmin.lockEventEntries).toHaveBeenCalledWith(9));

    cleanup();
    mockAdmin.eventEntries.mockResolvedValue({ lockedAt: 'x', entries: [entry({ seed: 1 }), entry({ id: 2, name: 'Bats', seed: 2 })] });
    mockAdmin.reorderEventSeeds.mockResolvedValue({});
    render(<EntriesPanel eventId={9} status="checkin" checkin canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'Move Bats up' }));
    await waitFor(() => expect(mockAdmin.reorderEventSeeds).toHaveBeenCalledWith(9, [2, 1]));
  });

  it('keeps each row\'s Disqualify reason separate from every other row', async () => {
    mockAdmin.eventEntries.mockResolvedValue({ lockedAt: null, entries: [entry(), entry({ id: 2, name: 'Bats' })] });
    mockAdmin.disqualifyEventEntry.mockResolvedValue({});
    render(<EntriesPanel eventId={9} status="checkin" checkin canEdit />);
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
    render(<EntriesPanel eventId={9} status="live" checkin canEdit />);
    await screen.findByText(/Rats/);
    expect(screen.queryByRole('button', { name: 'Move Bats up' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Move .* down/ })).toBeNull();
  });

  const buttons = async (status: string, checkin: boolean, lockedAt: string | null = null, entries = [entry()]) => {
    mockAdmin.eventEntries.mockResolvedValue({ lockedAt, entries });
    render(<EntriesPanel eventId={9} status={status} checkin={checkin} canEdit />);
    await screen.findByText(/Rats/);
    const names = screen.queryAllByRole('button').map((b) => b.textContent);
    cleanup();
    return names;
  };

  it('offers Open check-in only in registration with check-in on', async () => {
    expect(await buttons('registration', true)).toContain('Open check-in now');
    expect(await buttons('registration', false)).not.toContain('Open check-in now');
    expect(await buttons('checkin', true)).not.toContain('Open check-in now');
  });

  it('offers Close the entry list only in the phase that ends with it', async () => {
    expect(await buttons('registration', true)).not.toContain('Close the entry list now');
    expect(await buttons('checkin', true)).toContain('Close the entry list now');
    expect(await buttons('registration', false)).toContain('Close the entry list now');
    expect(await buttons('registration', false, 'x')).not.toContain('Close the entry list now');
  });

  it('offers Restore only before the list is final in registration or check-in', async () => {
    const out = [entry({ status: 'disqualified' })];
    expect(await buttons('registration', true, null, out)).toContain('Restore');
    expect(await buttons('checkin', true, null, out)).toContain('Restore');
    expect(await buttons('live', true, null, out)).not.toContain('Restore');
    expect(await buttons('cancelled', true, null, out)).not.toContain('Restore');
    expect(await buttons('checkin', true, 'x', out)).not.toContain('Restore');
  });

  describe('Replace player on a draft entry (plan D2c)', () => {
    const open = async (status = 'live', canEdit = true) => {
      mockAdmin.eventEntries.mockResolvedValue({ lockedAt: 'x', entries: [draftEntry()], bench: [{ steamid: 'b1', name: 'benchy' }] });
      render(<EntriesPanel eventId={9} status={status} checkin={false} draft canEdit={canEdit} />);
      await screen.findByText(/Team c0/);
    };

    it('is offered on each starter but the captain, to admins only, and not once the event is over', async () => {
      await open();
      expect(screen.queryByRole('button', { name: 'Replace player c0' })).toBeNull();
      expect(screen.getAllByRole('button', { name: /^Replace player s\d$/ })).toHaveLength(3);
      cleanup();
      await open('live', false);
      expect(screen.queryByRole('button', { name: /Replace player/ })).toBeNull();
      cleanup();
      await open('finished');
      expect(screen.queryByRole('button', { name: /Replace player/ })).toBeNull();
    });

    it('offers the bench first, needs a reason, and confirms with who loses their place', async () => {
      mockAdmin.replaceEntryPlayer.mockResolvedValue({ subbedInMatch: null });
      await open();
      fireEvent.click(screen.getByRole('button', { name: 'Replace player s2' }));
      const dialog = screen.getByRole('group', { name: 'Replace s2' });
      expect(dialog).toBeTruthy();
      const pick = screen.getByLabelText('Replacement') as HTMLSelectElement;
      expect([...pick.options].map((o) => o.textContent)).toEqual(['Choose the replacement', 'benchy']);
      expect([...(screen.getByLabelText('Reason') as HTMLSelectElement).options].map((o) => o.textContent))
        .toEqual(['Choose a reason', 'Conduct', 'Cheating', 'No-show', 'Left the event', 'Other']);
      const go = screen.getByRole('button', { name: 'Replace' }) as HTMLButtonElement;
      fireEvent.change(pick, { target: { value: 'b1' } });
      // A reason is required.
      expect(go.disabled).toBe(true);
      fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'conduct' } });
      fireEvent.input(screen.getByLabelText('Staff note'), { target: { value: '  Toxic in voice  ' } });
      expect((screen.getByLabelText('Staff note') as HTMLInputElement).maxLength).toBe(200);
      expect(go.disabled).toBe(false);
      fireEvent.click(go);
      await waitFor(() => expect(mockAdmin.replaceEntryPlayer).toHaveBeenCalledWith(9, 1, { out: 's2', in: 'b1', reason: 'conduct', note: 'Toxic in voice' }));
      expect(confirm).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Replace s2 with benchy?', body: 's2 loses their place on Team c0. This is not a ban; use the ban tools for that.',
      }));
      await waitFor(() => expect(screen.queryByRole('group', { name: 'Replace s2' })).toBeNull());
    });

    it('shows the server\'s refusal and its details under the form, and keeps the form open', async () => {
      const { ApiError } = await import('../../../api');
      mockAdmin.replaceEntryPlayer.mockRejectedValue(new ApiError(409, 'That player is in a game on a server and the server did not take the change.', undefined,
        [{ steamid: 's2', name: 's2', problems: ['The server said: not between chapters.'] }]));
      await open();
      fireEvent.click(screen.getByRole('button', { name: 'Replace player s2' }));
      fireEvent.change(screen.getByLabelText('Replacement'), { target: { value: 'b1' } });
      fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'cheating' } });
      fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
      expect(await screen.findByText(/The server said: not between chapters\./)).toBeTruthy();
      expect(screen.getByText('That player is in a game on a server and the server did not take the change.')).toBeTruthy();
      expect(screen.getByRole('group', { name: 'Replace s2' })).toBeTruthy();
    });

    it('finds another player by the People search, leaving out the team\'s own players', async () => {
      mockAdmin.replaceEntryPlayer.mockResolvedValue({ subbedInMatch: null });
      mockPeople.people.mockResolvedValue({ players: [{ steamid: 's1', name: 's1' }, { steamid: 'x9', name: 'outsider' }] });
      await open();
      fireEvent.click(screen.getByRole('button', { name: 'Replace player s3' }));
      fireEvent.input(screen.getByLabelText('Find another player'), { target: { value: 'outs' } });
      fireEvent.click(screen.getByRole('button', { name: 'Search' }));
      await waitFor(() => expect(mockPeople.people).toHaveBeenCalledWith('outs'));
      const pick = screen.getByLabelText('Replacement') as HTMLSelectElement;
      await waitFor(() => expect([...pick.options].map((o) => o.textContent)).toEqual(['Choose the replacement', 'benchy', 'outsider']));
      fireEvent.change(pick, { target: { value: 'x9' } });
      fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'cheating' } });
      fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
      await waitFor(() => expect(mockAdmin.replaceEntryPlayer).toHaveBeenCalledWith(9, 1, { out: 's3', in: 'x9', reason: 'cheating', note: null }));
    });
  });

  it('tells the editor after closing the list or opening check-in', async () => {
    mockAdmin.eventEntries.mockResolvedValue({ lockedAt: null, entries: [entry()] });
    mockAdmin.lockEventEntries.mockResolvedValue({});
    mockAdmin.openEventCheckin.mockResolvedValue({});
    const onChange = vi.fn();
    render(<EntriesPanel eventId={9} status="checkin" checkin canEdit onChange={onChange} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Close the entry list now' }));
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    cleanup();
    render(<EntriesPanel eventId={9} status="registration" checkin canEdit onChange={onChange} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open check-in now' }));
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(2));
  });
});
