import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { EventDraftView, MyEventView } from '../../api';

const { mockEvents } = vi.hoisted(() => ({
  mockEvents: { signUp: vi.fn(), withdrawSignup: vi.fn(), answerCaptainOffer: vi.fn() },
}));
vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return { ...actual, eventsApi: { ...actual.eventsApi, ...mockEvents } };
});
const confirmMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../../components/Confirm', () => ({ confirm: confirmMock }));
const { DraftSignupPanel } = await import('./DraftSignupPanel');
const { ApiError } = await import('../../api');

const future = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
const draft = (over: Partial<EventDraftView> = {}): EventDraftView =>
  ({ signupsCloseAt: future(60), draftAt: future(120), signups: 4, names: [], cut: null, ...over });
const mine = (over: Partial<MyEventView> = {}): MyEventView =>
  ({ entries: [], register: [], canRegister: false, signup: null, offer: null, ...over });
const base = { slug: 'night', eventName: 'Draft Night', status: 'registration' as const, lockedAt: null as string | null, onChange: () => {} };

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('DraftSignupPanel', () => {
  it('signs up with the chosen preference and note', async () => {
    mockEvents.signUp.mockResolvedValue({ ok: true });
    const onChange = vi.fn();
    render(<DraftSignupPanel {...base} draft={draft()} view={mine()} onChange={onChange} />);
    expect(screen.getByLabelText('I want to captain')).toBeTruthy();
    expect(screen.getByLabelText('I don\'t want to captain')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('I\'ll captain if needed'));
    const note = screen.getByPlaceholderText('e.g. prefer infected, can\'t play after 02:00 UTC') as HTMLInputElement;
    expect(note.maxLength).toBe(80);
    fireEvent.input(note, { target: { value: 'prefer infected' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign up' }));
    await waitFor(() => expect(mockEvents.signUp).toHaveBeenCalledWith('night', { captainPref: 'willing', note: 'prefer infected' }));
    expect(onChange).toHaveBeenCalled();
  });

  it('shows the problem sentences of an ineligible signup', async () => {
    mockEvents.signUp.mockRejectedValue(new ApiError(409, 'You do not meet the entry rules for this event.', undefined,
      [{ steamid: '1', name: 'me', problems: ['Discord is not linked'] }]));
    render(<DraftSignupPanel {...base} draft={draft()} view={mine()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign up' }));
    expect(await screen.findByText('You do not meet the entry rules for this event.')).toBeTruthy();
    expect(screen.getByText(/me: Discord is not linked/)).toBeTruthy();
  });

  it('a signed-up player sees their own choice and note, and withdraw asks first', async () => {
    mockEvents.withdrawSignup.mockResolvedValue({ ok: true });
    render(<DraftSignupPanel {...base} draft={draft()} view={mine({ signup: { captainPref: 'want', note: 'prefer infected', role: null } })} />);
    expect(screen.getByText('You are signed up')).toBeTruthy();
    expect(screen.getByText(/I want to captain/)).toBeTruthy();
    expect(screen.getByText(/prefer infected/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw' }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    await waitFor(() => expect(mockEvents.withdrawSignup).toHaveBeenCalledWith('night'));
  });

  it('does not withdraw when the confirm is declined', async () => {
    confirmMock.mockResolvedValueOnce(false);
    render(<DraftSignupPanel {...base} draft={draft()} view={mine({ signup: { captainPref: 'no', note: null, role: null } })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw' }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(mockEvents.withdrawSignup).not.toHaveBeenCalled();
  });

  it('says signups are closed once they close, before the cut', () => {
    render(<DraftSignupPanel {...base} lockedAt={future(-5)} draft={draft()} view={mine({ signup: { captainPref: 'no', note: null, role: null } })} />);
    expect(screen.getByText('Signups are closed. Staff are making the cut; you will get a DM with your role.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Withdraw' })).toBeNull();
  });

  it('closes on the clock even when the lock is not stamped yet', () => {
    render(<DraftSignupPanel {...base} draft={draft({ signupsCloseAt: future(-1) })} view={mine({ signup: { captainPref: 'no', note: null, role: null } })} />);
    expect(screen.getByText(/Signups are closed\./)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign up' })).toBeNull();
  });

  it.each([
    ['captain', 'Your role: Captain', /You are a captain\. Teams are made .+: staff either balance them by SR or you pick your players live, and you will hear which\./],
    ['pool', 'Your role: Pool', /You are in the player pool\. Teams are made .+, by SR balance or a live captains' draft; you will get a DM with your team\./],
    ['bench', 'Your role: Bench', /You are on the free-agent bench\. Teams are made .+; captains can call on you as a stand-in/],
  ] as const)('after publish a %s sees their role', (role, head, line) => {
    render(<DraftSignupPanel {...base} lockedAt={future(-5)} draft={draft({ cut: { captains: [], pool: [], bench: [] } })}
      view={mine({ signup: { captainPref: 'want', note: null, role } })} />);
    expect(screen.getByText(head)).toBeTruthy();
    expect(screen.getByText(line)).toBeTruthy();
  });

  it('an open offer shows Accept and Decline', async () => {
    mockEvents.answerCaptainOffer.mockResolvedValue({ ok: true });
    const onChange = vi.fn();
    render(<DraftSignupPanel {...base} lockedAt={future(-5)} draft={draft()} onChange={onChange}
      view={mine({ signup: { captainPref: 'willing', note: null, role: null }, offer: { expiresAt: future(20) } })} />);
    expect(screen.getByText(/Draft Night needs another captain\. Accept by /)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(mockEvents.answerCaptainOffer).toHaveBeenCalledWith('night', true));
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    await waitFor(() => expect(mockEvents.answerCaptainOffer).toHaveBeenCalledWith('night', false));
    expect(onChange).toHaveBeenCalled();
  });

  it('shows nothing about signing up before signups open', () => {
    render(<DraftSignupPanel {...base} status="announced" draft={draft()} view={mine()} />);
    expect(screen.queryByRole('button', { name: 'Sign up' })).toBeNull();
    expect(screen.getByText('Signups are not open yet.')).toBeTruthy();
  });
});
