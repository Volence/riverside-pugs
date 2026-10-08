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
  expiresAt: '2026-10-19T22:00:00.000Z', closed: false, myAnswer: null, made: null,
  players: [{ steamid: 's0', name: 'cap', captain: true, answer: null }, { steamid: 's1', name: 'ann', captain: false, answer: null }, { steamid: 's2', name: 'bob', captain: false, answer: null }, { steamid: 's3', name: 'dee', captain: false, answer: null }],
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
      { steamid: 's0', name: 'cap', captain: true, answer: 'accept' }, { steamid: 's1', name: 'ann', captain: false, answer: null }, { steamid: 's2', name: 'bob', captain: false, answer: 'decline' }, { steamid: 's3', name: 'dee', captain: false, answer: null },
    ] }) });
    mockEvents.answerKeep.mockResolvedValue({ joined: false, teamSlug: null, closed: false });
    render(<KeepTeamPanel slug="cup" />);
    expect(await screen.findByText(/Night Owls \[OWL\]: made when 3 of the 4 of you accept/)).toBeTruthy();
    expect(screen.getByText(/bob · Declined/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(mockEvents.answerKeep).toHaveBeenCalledWith('cup', true));
  });

  it('a made team shows its real name and tag with a link, not the vote line, and offers a late accept only to who has not answered', async () => {
    const made = { name: 'Night Owls 2', tag: 'OWL2', slug: 'night-owls-2' };
    mockEvents.keep.mockResolvedValue({ keep: keep({ status: 'made', captain: false, name: 'Night Owls', tag: 'OWL', myAnswer: 'accept', made }) });
    render(<KeepTeamPanel slug="cup" />);
    expect((await screen.findByRole('link', { name: 'Night Owls 2 [OWL2]' })).getAttribute('href')).toBe('/team/night-owls-2');
    expect(screen.getByText(/is a team now/)).toBeTruthy();
    expect(screen.queryByText(/made when 3 of the 4/)).toBeNull();
    expect(screen.queryByText(/Accept to join by/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
    cleanup();
    mockEvents.keep.mockResolvedValue({ keep: keep({ status: 'made', captain: false, name: 'Night Owls', tag: 'OWL', myAnswer: null, made }) });
    render(<KeepTeamPanel slug="cup" />);
    expect(await screen.findByText(/Accept to join by/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Accept' })).toBeTruthy();
    cleanup();
    mockEvents.keep.mockResolvedValue({ keep: keep({ status: 'made', captain: false, name: 'Night Owls', tag: 'OWL', myAnswer: null, closed: true, made }) });
    render(<KeepTeamPanel slug="cup" />);
    await screen.findByText(/is a team now/);
    expect(screen.queryByText(/Accept to join by/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
  });

  it('lists two players with one display name as two rows', async () => {
    mockEvents.keep.mockResolvedValue({ keep: keep({ status: 'voting', captain: false, name: 'Night Owls', tag: 'OWL', players: [
      { steamid: 's0', name: 'cap', captain: true, answer: 'accept' }, { steamid: 's1', name: 'sam', captain: false, answer: null }, { steamid: 's2', name: 'sam', captain: false, answer: 'decline' }, { steamid: 's3', name: 'dee', captain: false, answer: null },
    ] }) });
    render(<KeepTeamPanel slug="cup" />);
    expect(await screen.findAllByText(/^sam/)).toHaveLength(2);
  });

  it('says so when an accept closed the keep with no team', async () => {
    mockEvents.keep.mockResolvedValue({ keep: keep({ status: 'voting', captain: false, name: 'Night Owls', tag: 'OWL' }) });
    mockEvents.answerKeep.mockResolvedValue({ joined: false, teamSlug: null, closed: true });
    render(<KeepTeamPanel slug="cup" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }));
    expect(await screen.findByText('This keep was closed and no team was made.')).toBeTruthy();
  });

  it('says when the window closed', async () => {
    mockEvents.keep.mockResolvedValue({ keep: keep({ status: 'lapsed', closed: true }) });
    render(<KeepTeamPanel slug="cup" />);
    expect(await screen.findByText('Keep this team has closed.')).toBeTruthy();
  });
});
