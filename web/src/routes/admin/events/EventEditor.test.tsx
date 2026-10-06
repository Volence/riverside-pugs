import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { AdminEventDetail, AdminEventOptions, AdminEventStage, EventFields, VetoConfig } from '../../../api';

const BAN_TO_ONE: VetoConfig = { games: 1, banTo: 1, firstBan: 'higher_chooses', firstPick: 'first', laterPicks: 'alternate', lateBans: 0, sides: 'non_picker' };

const { mockAdmin, mockConfirm } = vi.hoisted(() => ({
  mockAdmin: {
    event: vi.fn(), eventOptions: vi.fn(), updateEvent: vi.fn(), addStage: vi.fn(), updateStage: vi.fn(), removeStage: vi.fn(),
    reorderStages: vi.fn(), publishEvent: vi.fn(), openEventRegistration: vi.fn(), cancelEvent: vi.fn(),
    setEventBanner: vi.fn(), removeEventBanner: vi.fn(), deleteEvent: vi.fn(), eventEntries: vi.fn(), eventPlay: vi.fn(), startEvent: vi.fn(),
    setRoundSchedule: vi.fn(),
  },
  mockConfirm: vi.fn(),
}));
vi.mock('../../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api')>();
  return { ...actual, adminApi: { ...actual.adminApi, ...mockAdmin } };
});
vi.mock('../../../components/Confirm', () => ({ confirm: mockConfirm }));
vi.mock('../../../eventBanner', () => ({ toBannerImage: vi.fn(async () => 'BASE64') }));
const { EventEditor } = await import('./EventEditor');
const { ApiError } = await import('../../../api');
const { LocationProvider } = await import('preact-iso');

const OPTIONS: AdminEventOptions = {
  campaigns: [{ slug: 'no_mercy', name: 'No Mercy' }, { slug: 'dead_air', name: 'Dead Air' }, { slug: 'death_toll', name: 'Death Toll' }],
  defaultPool: ['no_mercy', 'dead_air'], rulesets: [{ id: 2, name: 'Standard Cup', summary: '3 pauses of 120 s · higher seed picks sides · 15 min no-show grace' }],
  defaultRulesetId: 2,
  gameConfigs: [{ key: 'standard', label: 'Standard' }],
  defaults: {
    eligibility: { minPugs: 5, requireDiscord: true, srFloor: null, srCeiling: null },
    checkin: { enabled: true, opensMinutes: 60, closesMinutes: 15 },
    roster: { starters: 4, maxSubs: 2, lock: { kind: 'none' }, maxAdditions: null },
  },
};
const FIELDS: EventFields = {
  name: 'Riverside Cup', startsAt: '2026-10-10T20:00:00.000Z', entryKind: 'team', official: true, teamCap: null, description: '',
  eligibility: OPTIONS.defaults.eligibility, checkin: OPTIONS.defaults.checkin, roster: OPTIONS.defaults.roster,
};
const stage = (id: number, ordinal: number, swiss: boolean): AdminEventStage => ({
  id, ordinal, rulesSnapshotted: false,
  summary: swiss ? 'Swiss, 4 rounds, top 8 advance' : 'Single elimination',
  settings: {
    type: swiss ? 'swiss' : 'single_elim', config: swiss ? { rounds: 4 } : { thirdPlace: false }, rulesetId: 2, gameConfig: 'standard',
    campaignPool: ['no_mercy', 'dead_air'], vetoType: 'ban_to_one', veto: BAN_TO_ONE, chapters: null, scheduling: 'rolling', advanceCount: swiss ? 8 : null,
  },
  schedule: [], roundsKnown: null,
});
const detail = (over: Partial<AdminEventDetail> = {}): AdminEventDetail => ({
  id: 3, slug: 'riverside-cup', status: 'draft', fields: FIELDS, bannerKey: null, cancelReason: null,
  createdAt: '2026-10-01T12:00:00.000Z', updatedAt: '2026-10-01T12:00:00.000Z',
  stages: [stage(10, 1, true), stage(11, 2, false)],
  log: [{ at: '2026-10-01T12:00:00.000Z', actorName: 'boss', action: 'created', detail: {} }],
  ...over,
});

afterEach(() => { cleanup(); history.replaceState(null, '', '/'); });
beforeEach(() => {
  for (const f of [...Object.values(mockAdmin), mockConfirm]) f.mockReset();
  mockAdmin.eventOptions.mockResolvedValue(OPTIONS);
  mockAdmin.eventEntries.mockResolvedValue({ lockedAt: null, entries: [] });
  mockAdmin.eventPlay.mockResolvedValue({ status: 'registration', lockedAt: null, startsAt: FIELDS.startsAt, seeded: 0, stages: [] });
  mockConfirm.mockResolvedValue(true);
  for (const f of [mockAdmin.updateEvent, mockAdmin.addStage, mockAdmin.updateStage, mockAdmin.removeStage, mockAdmin.reorderStages,
    mockAdmin.publishEvent, mockAdmin.openEventRegistration, mockAdmin.cancelEvent, mockAdmin.setEventBanner,
    mockAdmin.removeEventBanner, mockAdmin.deleteEvent]) f.mockResolvedValue({ ok: true });
});

describe('EventEditor', () => {
  it('shows a draft with its stages, history, Publish and no Open registration', async () => {
    mockAdmin.event.mockResolvedValue(detail());
    render(<EventEditor id={3} canEdit />);
    expect(await screen.findByText('Swiss, 4 rounds, top 8 advance')).toBeTruthy();
    expect(screen.getByText('Single elimination')).toBeTruthy();
    expect(screen.getByText(/boss · Created/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Publish' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open registration' })).toBeNull();
    expect((screen.getByLabelText('Entry kind') as HTMLSelectElement).disabled).toBe(false);
  });

  it('Publish asks first, then publishes and reloads', async () => {
    mockAdmin.event.mockResolvedValue(detail());
    render(<EventEditor id={3} canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(mockAdmin.publishEvent).toHaveBeenCalledWith(3));
    expect(mockConfirm).toHaveBeenCalled();
    await waitFor(() => expect(mockAdmin.event).toHaveBeenCalledTimes(2));
  });

  it('moves a stage up by sending the swapped order', async () => {
    mockAdmin.event.mockResolvedValue(detail());
    render(<EventEditor id={3} canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'Move stage 2 up' }));
    await waitFor(() => expect(mockAdmin.reorderStages).toHaveBeenCalledWith(3, [11, 10]));
    expect((screen.getByRole('button', { name: 'Move stage 1 up' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('adds a stage from the form, starting from the site pool', async () => {
    mockAdmin.event.mockResolvedValue(detail());
    render(<EventEditor id={3} canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add stage' }));
    expect((screen.getByLabelText('No Mercy') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Death Toll') as HTMLInputElement).checked).toBe(false);
    fireEvent.change(screen.getByLabelText('Stage type'), { target: { value: 'swiss' } });
    fireEvent.input(screen.getByLabelText('Rounds'), { target: { value: '5' } });
    fireEvent.click(screen.getByLabelText('Death Toll'));
    fireEvent.input(screen.getByLabelText('Advance count'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save stage' }));
    await waitFor(() => expect(mockAdmin.addStage).toHaveBeenCalledWith(3, {
      type: 'swiss', config: { rounds: 5 }, rulesetId: 2, gameConfig: 'standard', campaignPool: ['no_mercy', 'dead_air', 'death_toll'],
      vetoType: 'ban_to_one', veto: BAN_TO_ONE, chapters: null, scheduling: 'rolling', advanceCount: 4,
    }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save stage' })).toBeNull());
  });

  it('keeps the stage form open when the server refuses it', async () => {
    mockAdmin.event.mockResolvedValue(detail());
    mockAdmin.addStage.mockRejectedValue(new ApiError(400, 'An advance count is 2 to 128 teams.'));
    render(<EventEditor id={3} canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add stage' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save stage' }));
    expect(await screen.findByText('An advance count is 2 to 128 teams.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save stage' })).toBeTruthy();
  });

  it('saves edited fields with the start time unchanged', async () => {
    mockAdmin.event.mockResolvedValue(detail());
    render(<EventEditor id={3} canEdit />);
    fireEvent.input(await screen.findByLabelText('Team cap'), { target: { value: '16' } });
    fireEvent.input(screen.getByLabelText('Description'), { target: { value: 'Line one\nLine two' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save event' }));
    await waitFor(() => expect(mockAdmin.updateEvent).toHaveBeenCalledWith(3, { ...FIELDS, teamCap: 16, description: 'Line one\nLine two' }));
  });

  it('an announced team event offers Open registration and locks the entry kind; a draft-kind one does not offer it', async () => {
    mockAdmin.event.mockResolvedValue(detail({ status: 'announced' }));
    const first = render(<EventEditor id={3} canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open registration' }));
    await waitFor(() => expect(mockAdmin.openEventRegistration).toHaveBeenCalledWith(3));
    expect((screen.getByLabelText('Entry kind') as HTMLSelectElement).disabled).toBe(true);
    first.unmount();
    mockAdmin.event.mockResolvedValue(detail({ status: 'announced', fields: { ...FIELDS, entryKind: 'draft' } }));
    render(<EventEditor id={3} canEdit />);
    await screen.findByText('Swiss, 4 rounds, top 8 advance');
    expect(screen.queryByRole('button', { name: 'Open registration' })).toBeNull();
  });

  it('cancels with the reason typed, after asking', async () => {
    mockAdmin.event.mockResolvedValue(detail({ status: 'registration' }));
    render(<EventEditor id={3} canEdit />);
    fireEvent.input(await screen.findByLabelText('Cancel reason'), { target: { value: 'Not enough teams' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel event' }));
    await waitFor(() => expect(mockAdmin.cancelEvent).toHaveBeenCalledWith(3, 'Not enough teams'));
    expect(mockConfirm).toHaveBeenCalled();
  });

  it('a live event has no stage controls, no field form and no cancel reason box beyond Cancel', async () => {
    mockAdmin.event.mockResolvedValue(detail({ status: 'live' }));
    render(<EventEditor id={3} canEdit />);
    await screen.findByText('Swiss, 4 rounds, top 8 advance');
    expect(screen.queryByRole('button', { name: 'Add stage' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Move stage 2 up' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save event' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Cancel event' })).toBeTruthy();
  });

  it('starting the event from the Play panel reloads the editor and the Entries panel', async () => {
    mockAdmin.event.mockResolvedValue(detail({ status: 'checkin' }));
    mockAdmin.eventEntries.mockResolvedValue({ lockedAt: 'x', entries: [] });
    mockAdmin.eventPlay.mockResolvedValue({ status: 'checkin', lockedAt: 'x', startsAt: FIELDS.startsAt, seeded: 2, stages: [] });
    mockAdmin.startEvent.mockResolvedValue({});
    render(<EventEditor id={3} canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'Start the event now' }));
    await waitFor(() => expect(mockAdmin.startEvent).toHaveBeenCalledWith(3));
    await waitFor(() => expect(mockAdmin.event).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mockAdmin.eventEntries).toHaveBeenCalledTimes(2));
  });

  it('a cancelled event shows its reason and nothing to press', async () => {
    mockAdmin.event.mockResolvedValue(detail({ status: 'cancelled', cancelReason: 'Not enough teams' }));
    render(<EventEditor id={3} canEdit />);
    expect(await screen.findByText('Cancelled: Not enough teams')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel event' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
  });

  it('previews the description with the same formatter the event page uses', async () => {
    mockAdmin.event.mockResolvedValue(detail());
    render(<EventEditor id={3} canEdit />);
    fireEvent.input(await screen.findByLabelText('Description'), { target: { value: '**Bring snacks**' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(screen.getByText('Bring snacks').tagName).toBe('STRONG');
    expect(screen.queryByLabelText('Description')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value).toBe('**Bring snacks**');
  });

  it('uploads a banner from the picked file, and removes one after asking', async () => {
    mockAdmin.event.mockResolvedValue(detail());
    const { rerender } = render(<EventEditor id={3} canEdit />);
    const input = await screen.findByLabelText('Banner');
    fireEvent.change(input, { target: { files: [new File(['x'], 'b.jpg', { type: 'image/jpeg' })] } });
    await waitFor(() => expect(mockAdmin.setEventBanner).toHaveBeenCalledWith(3, 'BASE64'));
    mockAdmin.event.mockResolvedValue(detail({ bannerKey: 'e'.repeat(64) }));
    rerender(<EventEditor id={4} canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove banner' }));
    await waitFor(() => expect(mockAdmin.removeEventBanner).toHaveBeenCalledWith(4));
    expect(mockConfirm).toHaveBeenCalled();
  });

  it('a mod reads the event, its banner, stages and history, with no control anywhere', async () => {
    mockAdmin.event.mockResolvedValue(detail({ bannerKey: 'e'.repeat(64), fields: { ...FIELDS, description: '*Team event*' } }));
    const { container } = render(<EventEditor id={3} canEdit={false} />);
    expect(await screen.findByText('Swiss, 4 rounds, top 8 advance')).toBeTruthy();
    expect(screen.getByText('Read only: admins run events.')).toBeTruthy();
    expect(screen.getByText(/boss · Created/)).toBeTruthy();
    expect(screen.getByText('Team event').tagName).toBe('EM');
    // The desk's own banner route: the public one is behind the switch.
    expect(container.querySelector('img.eventbanner')!.getAttribute('src')).toBe(`/api/admin/events/3/banner?k=${'e'.repeat(64)}`);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(container.querySelectorAll('input, select, textarea')).toHaveLength(0);
  });

  it('says so for an event that does not exist', async () => {
    mockAdmin.event.mockRejectedValue(new ApiError(404, 'No such event.'));
    render(<EventEditor id={99} canEdit />);
    expect(await screen.findByText('No such event.')).toBeTruthy();
  });

  it('a draft is deleted, not cancelled: Delete draft asks, deletes and goes back to the desk', async () => {
    mockAdmin.event.mockResolvedValue(detail());
    history.replaceState(null, '', '/admin/events/3');
    render(<LocationProvider><EventEditor id={3} canEdit /></LocationProvider>);
    await screen.findByText('Swiss, 4 rounds, top 8 advance');
    expect(screen.queryByRole('button', { name: 'Cancel event' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Delete draft' }));
    await waitFor(() => expect(mockAdmin.deleteEvent).toHaveBeenCalledWith(3));
    expect(mockConfirm).toHaveBeenCalled();
    await waitFor(() => expect(location.pathname).toBe('/admin/events'));
  });

  it('stays on the draft when Delete draft is refused, and offers it only on a draft', async () => {
    mockAdmin.event.mockResolvedValue(detail());
    mockAdmin.deleteEvent.mockRejectedValue(new ApiError(409, 'The event is not at a step that allows that.'));
    history.replaceState(null, '', '/admin/events/3');
    const first = render(<LocationProvider><EventEditor id={3} canEdit /></LocationProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete draft' }));
    expect(await screen.findByText('The event is not at a step that allows that.')).toBeTruthy();
    expect(location.pathname).toBe('/admin/events/3');
    first.unmount();
    mockAdmin.event.mockResolvedValue(detail({ status: 'announced' }));
    render(<EventEditor id={3} canEdit />);
    await screen.findByText('Swiss, 4 rounds, top 8 advance');
    expect(screen.queryByRole('button', { name: 'Delete draft' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Cancel event' })).toBeTruthy();
  });

  it('keeps unsaved typing through a banner upload that reloads the event', async () => {
    mockAdmin.event.mockResolvedValue(detail());
    render(<EventEditor id={3} canEdit />);
    fireEvent.input(await screen.findByLabelText('Description'), { target: { value: 'Half written' } });
    mockAdmin.event.mockResolvedValue(detail({ bannerKey: 'e'.repeat(64), updatedAt: '2026-10-01T13:00:00.000Z' }));
    fireEvent.change(screen.getByLabelText('Banner'), { target: { files: [new File(['x'], 'b.png', { type: 'image/png' })] } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove banner' })).toBeTruthy());
    expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value).toBe('Half written');
  });

  it('after its own save, the form shows the event as the server stored it', async () => {
    mockAdmin.event.mockResolvedValue(detail());
    render(<EventEditor id={3} canEdit />);
    fireEvent.input(await screen.findByLabelText('Description'), { target: { value: '  Bring snacks  ' } });
    mockAdmin.event.mockResolvedValue(detail({ fields: { ...FIELDS, description: 'Bring snacks' }, updatedAt: '2026-10-01T13:00:00.000Z' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save event' }));
    await waitFor(() => expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value).toBe('Bring snacks'));
  });

  it('shows stage values that are no longer offered, so they can be cleared', async () => {
    const old = stage(10, 1, true);
    old.settings = { ...old.settings, rulesetId: 9, gameConfig: 'retired', campaignPool: ['no_mercy', 'hard_rain'] };
    mockAdmin.event.mockResolvedValue(detail({ stages: [old, stage(11, 2, false)] }));
    render(<EventEditor id={3} canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit stage 1' }));
    const ruleset = screen.getByLabelText('Ruleset') as HTMLSelectElement;
    expect(ruleset.value).toBe('9');
    expect(ruleset.selectedOptions[0]!.textContent).toBe('Ruleset 9 (no longer available)');
    const config = screen.getByLabelText('Game config') as HTMLSelectElement;
    expect(config.value).toBe('retired');
    expect(config.selectedOptions[0]!.textContent).toBe('retired (no longer available)');
    const stale = screen.getByLabelText('hard_rain (no longer available)') as HTMLInputElement;
    expect(stale.checked).toBe(true);
    fireEvent.click(stale);
    fireEvent.change(ruleset, { target: { value: '2' } });
    fireEvent.change(config, { target: { value: 'standard' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save stage' }));
    await waitFor(() => expect(mockAdmin.updateStage).toHaveBeenCalledWith(3, 10, expect.objectContaining({
      rulesetId: 2, gameConfig: 'standard', campaignPool: ['no_mercy'],
    })));
  });

  it('a blank stage number that must be set is an error and nothing is sent; a blank advance count is none', async () => {
    mockAdmin.event.mockResolvedValue(detail());
    render(<EventEditor id={3} canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit stage 1' }));
    fireEvent.input(screen.getByLabelText('Rounds'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save stage' }));
    expect(await screen.findByText('Rounds needs a whole number.')).toBeTruthy();
    expect(mockAdmin.updateStage).not.toHaveBeenCalled();
    fireEvent.input(screen.getByLabelText('Rounds'), { target: { value: '5' } });
    fireEvent.input(screen.getByLabelText('Advance count'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save stage' }));
    await waitFor(() => expect(mockAdmin.updateStage).toHaveBeenCalledWith(3, 10, expect.objectContaining({ config: { rounds: 5 }, advanceCount: null })));
  });

  it('opens the round schedule editor for a stage at any status and saves it (plan T4)', async () => {
    mockAdmin.event.mockResolvedValue(detail({ status: 'live', stages: [{ ...stage(3, 1, true), rulesSnapshotted: true, schedule: [], roundsKnown: 4 }] }));
    mockAdmin.setRoundSchedule.mockResolvedValue({ stamped: 2 });
    render(<EventEditor id={1} canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'Schedule stage 1' }));
    fireEvent.input(screen.getByLabelText('Round 1 default time'), { target: { value: '2026-10-24T21:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }));
    await waitFor(() => expect(mockAdmin.setRoundSchedule).toHaveBeenCalledWith(1, 3, [{ round: 1, at: new Date('2026-10-24T21:00').toISOString(), from: null, to: null }]));
  });

  it('warns before applying a schedule to a live event\'s matches, but not a draft\'s (plan T4 review)', async () => {
    mockAdmin.event.mockResolvedValue(detail({ status: 'live', stages: [{ ...stage(3, 1, true), rulesSnapshotted: true, schedule: [], roundsKnown: 4 }] }));
    mockAdmin.setRoundSchedule.mockResolvedValue({ stamped: 2 });
    render(<EventEditor id={1} canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'Schedule stage 1' }));
    fireEvent.input(screen.getByLabelText('Round 1 default time'), { target: { value: '2026-10-24T21:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }));
    await waitFor(() => expect(mockAdmin.setRoundSchedule).toHaveBeenCalledTimes(1));
    expect(mockConfirm).toHaveBeenCalledWith({
      title: "Apply this schedule to the stage's waiting matches?",
      body: expect.stringContaining('kept'),
    });
    cleanup();

    mockAdmin.event.mockResolvedValue(detail({ status: 'draft' }));
    render(<EventEditor id={1} canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'Schedule stage 1' }));
    fireEvent.input(screen.getByLabelText('Round 1 default time'), { target: { value: '2026-10-24T21:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }));
    await waitFor(() => expect(mockAdmin.setRoundSchedule).toHaveBeenCalledTimes(2));
    expect(mockConfirm).toHaveBeenCalledTimes(1);
  });
});
