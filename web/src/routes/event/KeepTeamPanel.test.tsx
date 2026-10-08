// web/src/routes/event/KeepTeamPanel.test.tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { MyKeepView } from '../../api';

const { mockEvents } = vi.hoisted(() => ({ mockEvents: { keep: vi.fn(), startKeep: vi.fn(), answerKeep: vi.fn() } }));
vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return { ...actual, eventsApi: { ...actual.eventsApi, ...mockEvents } };
});
const { KeepTeamPanel } = await import('./KeepTeamPanel');

const keep = (over: Partial<MyKeepView> = {}): MyKeepView => ({
  keepId: 3, status: 'offered', captain: true, team: 'Team cap', name: null, tag: null, defaults: { name: 'Team cap', tag: 'CAP' },
  expiresAt: '2026-10-19T22:00:00.000Z', closed: false, myAnswer: null, teamSlug: null,
  players: [{ name: 'cap', captain: true, answer: null }, { name: 'ann', captain: false, answer: null }, { name: 'bob', captain: false, answer: null }, { name: 'dee', captain: false, answer: null }],
  ...over,
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('KeepTeamPanel', () => {
  it('renders nothing without a keep', async () => {
    mockEvents.keep.mockResolvedValue({ keep: null });
    const { container } = render(<KeepTeamPanel slug="cup" />);
    await waitFor(() => expect(mockEvents.keep).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(container.textContent).toBe('');
  });

  it('the captain keeps the team with the name and tag prefilled from the draft team', async () => {
    mockEvents.keep.mockResolvedValue({ keep: keep() });
    mockEvents.startKeep.mockResolvedValue({ keepId: 3 });
    render(<KeepTeamPanel slug="cup" />);
    expect((await screen.findByLabelText('Team name') as HTMLInputElement).value).toBe('Team cap');
    fireEvent.input(screen.getByLabelText('Team name'), { target: { value: 'Night Owls' } });
    fireEvent.click(screen.getByRole('button', { name: 'Keep this team' }));
    await waitFor(() => expect(mockEvents.startKeep).toHaveBeenCalledWith('cup', { name: 'Night Owls', tag: 'CAP' }));
  });

  it('a drafted player sees the answers so far and accepts', async () => {
    mockEvents.keep.mockResolvedValue({ keep: keep({ status: 'voting', captain: false, name: 'Night Owls', tag: 'OWL', players: [
      { name: 'cap', captain: true, answer: 'accept' }, { name: 'ann', captain: false, answer: null }, { name: 'bob', captain: false, answer: 'decline' }, { name: 'dee', captain: false, answer: null },
    ] }) });
    mockEvents.answerKeep.mockResolvedValue({ joined: false, teamSlug: null });
    render(<KeepTeamPanel slug="cup" />);
    expect(await screen.findByText(/Night Owls \[OWL\]: made when 3 of the 4 of you accept/)).toBeTruthy();
    expect(screen.getByText(/bob · Declined/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(mockEvents.answerKeep).toHaveBeenCalledWith('cup', true));
  });

  it('links the team once it is made, and says when the window closed', async () => {
    mockEvents.keep.mockResolvedValue({ keep: keep({ status: 'made', captain: false, name: 'Night Owls', tag: 'OWL', myAnswer: 'accept', teamSlug: 'night-owls' }) });
    render(<KeepTeamPanel slug="cup" />);
    expect((await screen.findByRole('link', { name: 'Open the team page' })).getAttribute('href')).toBe('/team/night-owls');
    cleanup();
    mockEvents.keep.mockResolvedValue({ keep: keep({ status: 'lapsed', closed: true }) });
    render(<KeepTeamPanel slug="cup" />);
    expect(await screen.findByText('Keep this team has closed.')).toBeTruthy();
  });
});
