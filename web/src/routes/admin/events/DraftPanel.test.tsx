import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { AdminDraftView, SignupFacts } from '../../../api';

const { mockAdmin, confirmMock } = vi.hoisted(() => ({
  mockAdmin: {
    eventDraft: vi.fn(), draftTeams: vi.fn(), draftCaptain: vi.fn(), draftSwap: vi.fn(), draftOffers: vi.fn(), draftPickCaptains: vi.fn(),
    closeSignups: vi.fn(), removeSignup: vi.fn(), draftPublishRaw: vi.fn(),
  },
  confirmMock: vi.fn(async () => true),
}));
vi.mock('../../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api')>();
  const { draftPublishRaw, ...rest } = mockAdmin;
  return { ...actual, adminApi: { ...actual.adminApi, ...rest, draftPublish: draftPublishRaw } };
});
vi.mock('../../../components/Confirm', () => ({ confirm: confirmMock }));
const { DraftPanel } = await import('./DraftPanel');
const { CutChangedError } = await import('../../../api');

const su = (over: Partial<SignupFacts> = {}): SignupFacts => ({
  steamid: '1', name: 'Ann', sr: 1500, captainPref: 'want', note: 'late start', signedUpAt: '2026-10-05T00:00:00.000Z',
  role: 'pool', manual: false, abandons30d: 0, noShows30d: 0, problems: [], ...over,
});
const view = (over: Partial<AdminDraftView> = {}): AdminDraftView => ({
  lockedAt: '2026-10-06T00:00:00.000Z', cutAt: null, teams: 2, maxTeams: 2, offersOn: false, openOffer: null, problems: [],
  signups: [su({ steamid: '1', name: 'Ann', role: 'captain' }), su({ steamid: '2', name: 'Bob', role: 'pool' }), su({ steamid: '3', name: 'Cy', role: 'bench' })], ...over,
});

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('DraftPanel', () => {
  it('renders the header, the problems as sentences and the table', async () => {
    mockAdmin.eventDraft.mockResolvedValue(view({
      problems: ['too_few_captains', 'pool_size', 'ineligible'],
      signups: [su({ problems: ['Discord is not linked'], abandons30d: 2, captainPref: 'no', role: 'captain', manual: true }), su({ steamid: '2', name: 'Bob' })],
    }));
    render(<DraftPanel eventId={9} canEdit />);
    expect(await screen.findByText(/2 signups · 2 teams \(most 2\)/)).toBeTruthy();
    expect(screen.getByText(/^1 more captain needed\. Offer captaincy/)).toBeTruthy();
    expect(screen.queryByText('Choose 1 more captain.')).toBeNull();
    expect(screen.getByText('The pool must be exactly 6.')).toBeTruthy();
    expect(screen.getByText('1 signup is not eligible; remove it.')).toBeTruthy();
    expect(screen.getByText('Discord is not linked')).toBeTruthy();
    expect(screen.getByText('2 abandons, 0 no-shows (30 d)')).toBeTruthy();
    expect(screen.getByText(/\(moved by hand\)/)).toBeTruthy();
    expect(screen.getByText(/\(did not volunteer\)/)).toBeTruthy();
    expect(screen.getAllByText('late start', { selector: 'td' })).toHaveLength(2);
  });

  it('marks a captain made by hand as not volunteering when they only said willing', async () => {
    mockAdmin.eventDraft.mockResolvedValue(view({
      signups: [su({ steamid: '1', name: 'Ann', role: 'captain', captainPref: 'willing' }), su({ steamid: '2', name: 'Bob', role: 'captain', captainPref: 'want' })],
    }));
    render(<DraftPanel eventId={9} canEdit />);
    await screen.findByText('Bob', { selector: 'td' });
    expect(screen.getAllByText(/\(did not volunteer\)/)).toHaveLength(1);
  });

  it('with fewer than 8 signups tells staff to cancel and offers no team count', async () => {
    mockAdmin.eventDraft.mockResolvedValue(view({
      teams: 1, maxTeams: 1, problems: ['too_few_teams'],
      signups: Array.from({ length: 7 }, (_, i) => su({ steamid: String(i), name: `P${i}`, role: 'pool' })),
    }));
    render(<DraftPanel eventId={9} canEdit />);
    expect(await screen.findByText('A draft needs at least 8 signups; this one has 7. Cancel the event.')).toBeTruthy();
    expect(screen.queryByText('Set at least 2 teams.')).toBeNull();
    expect(screen.queryByLabelText('Team count')).toBeNull();
  });

  it('shows the open header before close', async () => {
    mockAdmin.eventDraft.mockResolvedValue(view({ lockedAt: null }));
    render(<DraftPanel eventId={9} canEdit signupsCloseAt="2026-10-08T12:00:00.000Z" />);
    expect(await screen.findByText(/Signups open until .*: 3 signed up/)).toBeTruthy();
    mockAdmin.closeSignups.mockResolvedValue({});
    fireEvent.click(screen.getByRole('button', { name: 'Close signups' }));
    await waitFor(() => expect(mockAdmin.closeSignups).toHaveBeenCalledWith(9));
  });

  it('Make captain calls draftCaptain', async () => {
    mockAdmin.eventDraft.mockResolvedValue(view());
    mockAdmin.draftCaptain.mockResolvedValue({});
    render(<DraftPanel eventId={9} canEdit />);
    await screen.findByText('Bob', { selector: 'td' });
    fireEvent.click(screen.getAllByRole('button', { name: 'Make captain' })[0]!);
    await waitFor(() => expect(mockAdmin.draftCaptain).toHaveBeenCalledWith(9, '2', true));
    fireEvent.click(screen.getByRole('button', { name: 'Remove captain' }));
    await waitFor(() => expect(mockAdmin.draftCaptain).toHaveBeenCalledWith(9, '1', false));
  });

  it('swaps a pool player with a bench player', async () => {
    mockAdmin.eventDraft.mockResolvedValue(view());
    mockAdmin.draftSwap.mockResolvedValue({});
    render(<DraftPanel eventId={9} canEdit />);
    await screen.findByText('Bob', { selector: 'td' });
    fireEvent.change(screen.getByLabelText('Swap Bob with'), { target: { value: '3' } });
    await waitFor(() => expect(mockAdmin.draftSwap).toHaveBeenCalledWith(9, '2', '3'));
    fireEvent.change(screen.getByLabelText('Swap Cy with'), { target: { value: '2' } });
    await waitFor(() => expect(mockAdmin.draftSwap).toHaveBeenCalledTimes(2));
    expect(mockAdmin.draftSwap).toHaveBeenLastCalledWith(9, '2', '3');
  });

  it('disables Publish while there are problems and confirms with the exact title when clear', async () => {
    mockAdmin.eventDraft.mockResolvedValue(view({ problems: ['pool_size'] }));
    render(<DraftPanel eventId={9} canEdit />);
    expect((await screen.findByRole('button', { name: 'Publish the cut' }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    mockAdmin.eventDraft.mockResolvedValue(view());
    mockAdmin.draftPublishRaw.mockResolvedValue({ captains: 2, pool: 6, bench: 0 });
    render(<DraftPanel eventId={9} canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'Publish the cut' }));
    await waitFor(() => expect(mockAdmin.draftPublishRaw).toHaveBeenCalledWith(9));
    expect(confirmMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'Publish the cut?' }));
  });

  it('shows the problems from a refused publish', async () => {
    mockAdmin.eventDraft.mockResolvedValue(view());
    mockAdmin.draftPublishRaw.mockRejectedValue(new CutChangedError(409, 'changed', {
      error: 'changed', problems: ['too_few_captains', 'pool_size'],
      cut: { teams: 2, maxTeams: 2, active: 7, captains: 1, pool: 5, poolNeeded: 6, bench: 1, unassigned: 0 }, ineligible: [],
    }));
    render(<DraftPanel eventId={9} canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'Publish the cut' }));
    expect(await screen.findByText('The cut was not published:')).toBeTruthy();
    expect(screen.getAllByText('Choose 1 more captain.').length).toBeGreaterThan(0);
  });

  it('Remove signup sends the chosen reason', async () => {
    mockAdmin.eventDraft.mockResolvedValue(view());
    mockAdmin.removeSignup.mockResolvedValue({});
    render(<DraftPanel eventId={9} canEdit />);
    await screen.findByText('Bob', { selector: 'td' });
    fireEvent.change(screen.getByLabelText('Reason for removing Bob'), { target: { value: 'ineligible' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove signup Bob' }));
    await waitFor(() => expect(mockAdmin.removeSignup).toHaveBeenCalledWith(9, '2', 'ineligible'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove signup Cy' }));
    await waitFor(() => expect(mockAdmin.removeSignup).toHaveBeenCalledWith(9, '3', 'removed'));
  });

  it('Remove signup asks first, and does nothing when declined', async () => {
    mockAdmin.eventDraft.mockResolvedValue(view());
    mockAdmin.removeSignup.mockResolvedValue({});
    render(<DraftPanel eventId={9} canEdit />);
    await screen.findByText('Bob', { selector: 'td' });
    confirmMock.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: 'Remove signup Bob' }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    expect(mockAdmin.removeSignup).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Reason for removing Bob'), { target: { value: 'ineligible' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove signup Bob' }));
    await waitFor(() => expect(mockAdmin.removeSignup).toHaveBeenCalledWith(9, '2', 'ineligible'));
    expect(confirmMock).toHaveBeenCalledTimes(2);
  });

  it('starts and stops offers and names the open offer', async () => {
    mockAdmin.eventDraft.mockResolvedValue(view());
    mockAdmin.draftOffers.mockResolvedValue({});
    render(<DraftPanel eventId={9} canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'Offer captaincy to willing signups' }));
    await waitFor(() => expect(mockAdmin.draftOffers).toHaveBeenCalledWith(9, true));
    cleanup();
    mockAdmin.eventDraft.mockResolvedValue(view({ offersOn: true, openOffer: { steamid: '3', name: 'Cy', expiresAt: '2026-10-07T12:00:00.000Z' } }));
    render(<DraftPanel eventId={9} canEdit />);
    expect(await screen.findByText(/Offered to Cy, answer by/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stop offers' }));
    await waitFor(() => expect(mockAdmin.draftOffers).toHaveBeenLastCalledWith(9, false));
  });

  it('sets the team count', async () => {
    mockAdmin.eventDraft.mockResolvedValue(view({ maxTeams: 3 }));
    mockAdmin.draftTeams.mockResolvedValue({});
    render(<DraftPanel eventId={9} canEdit />);
    fireEvent.input(await screen.findByLabelText('Team count'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set' }));
    await waitFor(() => expect(mockAdmin.draftTeams).toHaveBeenCalledWith(9, 3));
  });

  it('Pick captains asks first, then calls the API', async () => {
    mockAdmin.eventDraft.mockResolvedValue(view());
    mockAdmin.draftPickCaptains.mockResolvedValue({ ok: true, captains: ['1'], short: 1 });
    render(<DraftPanel eventId={9} canEdit />);
    confirmMock.mockResolvedValueOnce(false);
    fireEvent.click(await screen.findByRole('button', { name: 'Pick captains' }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    expect(mockAdmin.draftPickCaptains).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Pick captains' }));
    await waitFor(() => expect(mockAdmin.draftPickCaptains).toHaveBeenCalledWith(9));
    expect(confirmMock).toHaveBeenLastCalledWith(expect.objectContaining({
      title: 'Pick captains?',
      body: 'The highest-SR signups who want to or will captain become the 2 captains. This replaces the current captains and resets the pool and bench.',
    }));
  });

  it('derives the captains-needed line from the loaded cut: singular, plural, gone when met, one line with the problem', async () => {
    const caps = (n: number) => Array.from({ length: 4 }, (_, i) => su({ steamid: String(i), name: `P${i}`, role: i < n ? 'captain' : 'pool' }));
    mockAdmin.eventDraft.mockResolvedValue(view({ teams: 3, maxTeams: 3, problems: ['too_few_captains'], signups: caps(2) }));
    render(<DraftPanel eventId={9} canEdit />);
    expect(await screen.findByText('1 more captain needed. Offer captaincy to willing signups, or make someone captain by hand.')).toBeTruthy();
    expect(screen.queryByText(/^Choose /)).toBeNull();
    cleanup();
    mockAdmin.eventDraft.mockResolvedValue(view({ teams: 3, maxTeams: 3, problems: ['too_few_captains'], signups: caps(1) }));
    render(<DraftPanel eventId={9} canEdit />);
    expect(await screen.findByText(/^2 more captains needed\./)).toBeTruthy();
    cleanup();
    mockAdmin.eventDraft.mockResolvedValue(view({ teams: 2, maxTeams: 2, signups: caps(2) }));
    render(<DraftPanel eventId={9} canEdit />);
    await screen.findByText('P0', { selector: 'td' });
    expect(screen.queryByText(/captains? needed/)).toBeNull();
  });

  it('shows no Pick captains button before close, after publish, or to a mod', async () => {
    mockAdmin.eventDraft.mockResolvedValue(view({ lockedAt: null }));
    render(<DraftPanel eventId={9} canEdit />);
    await screen.findByText('Bob', { selector: 'td' });
    expect(screen.queryByRole('button', { name: 'Pick captains' })).toBeNull();
    cleanup();
    mockAdmin.eventDraft.mockResolvedValue(view({ cutAt: '2026-10-07T00:00:00.000Z' }));
    render(<DraftPanel eventId={9} canEdit />);
    await screen.findByText('Bob', { selector: 'td' });
    expect(screen.queryByRole('button', { name: 'Pick captains' })).toBeNull();
    cleanup();
    mockAdmin.eventDraft.mockResolvedValue(view());
    render(<DraftPanel eventId={9} canEdit={false} />);
    await screen.findByText('Bob', { selector: 'td' });
    expect(screen.queryByRole('button', { name: 'Pick captains' })).toBeNull();
  });

  it('gives a mod no buttons at all', async () => {
    mockAdmin.eventDraft.mockResolvedValue(view());
    render(<DraftPanel eventId={9} canEdit={false} />);
    await screen.findByText('Bob', { selector: 'td' });
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByText('Read only: admins run events.')).toBeTruthy();
  });

  it('shows a published cut with no actions', async () => {
    mockAdmin.eventDraft.mockResolvedValue(view({ cutAt: '2026-10-07T00:00:00.000Z' }));
    render(<DraftPanel eventId={9} canEdit />);
    expect(await screen.findByText(/Cut published/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
