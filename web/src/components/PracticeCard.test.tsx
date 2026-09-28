import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import type { PracticeParks } from '../api';

const { mockApi } = vi.hoisted(() => ({ mockApi: { practiceParks: vi.fn(), startPractice: vi.fn() } }));
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: { ...actual.api, ...mockApi } };
});

const { PracticeCard } = await import('./PracticeCard');
const { ApiError } = await import('../api');

const PARK = { id: 3, server: 'Riverside #4', humans: 5, capacity: 8, map: 'l4d_vs_hospital01_apartment', ready: true, endsAt: '2026-09-28T14:00:00Z' };
const parks = (over: Partial<PracticeParks> = {}): PracticeParks => ({ available: true, parks: [PARK], mine: null, ...over });

afterEach(cleanup);
beforeEach(() => { mockApi.practiceParks.mockReset(); mockApi.startPractice.mockReset(); });

describe('PracticeCard', () => {
  it('lists the open park with its head count out of eight and a Join to its page', async () => {
    mockApi.practiceParks.mockResolvedValue(parks());
    render(<PracticeCard signedIn />);
    expect(await screen.findByText('Riverside #4')).toBeTruthy();
    expect(screen.getByLabelText('5 of 8 players').textContent).toBe('5 / 8');
    expect(screen.getByRole('link', { name: 'Join' }).getAttribute('href')).toBe('/practice/3');
    // A park exists, so nobody is offered a second one.
    expect(screen.queryByRole('button', { name: 'Start a Practice Park' })).toBeNull();
  });

  it('offers to start a park when none is open, and says why it could not', async () => {
    mockApi.practiceParks.mockResolvedValue(parks({ parks: [] }));
    mockApi.startPractice.mockRejectedValue(new ApiError(503, 'All servers are busy with PUGs right now. Try again in a few minutes.'));
    render(<PracticeCard signedIn />);
    expect(await screen.findByText('Nobody is in the park right now.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Start a Practice Park' }));
    expect(mockApi.startPractice).toHaveBeenCalledWith({ kind: 'park' });
    expect((await screen.findByRole('alert')).textContent).toBe('All servers are busy with PUGs right now. Try again in a few minutes.');
  });

  it('signed out: lists parks, no Join, a sign-in link instead', async () => {
    mockApi.practiceParks.mockResolvedValue(parks());
    render(<PracticeCard signedIn={false} />);
    await screen.findByText('Riverside #4');
    expect(screen.queryByRole('link', { name: 'Join' })).toBeNull();
    const link = screen.getByRole('link', { name: 'Sign in to practise' });
    expect(link.getAttribute('target')).toBe('_top');
  });

  it('links back to your own practice server', async () => {
    mockApi.practiceParks.mockResolvedValue(parks({ mine: { id: 9, kind: 'drill' } }));
    render(<PracticeCard signedIn />);
    expect((await screen.findByRole('link', { name: 'Your drill server' })).getAttribute('href')).toBe('/practice/9');
  });

  it('hides itself where practice servers are not available', async () => {
    mockApi.practiceParks.mockResolvedValue(parks({ available: false }));
    const { container } = render(<PracticeCard signedIn />);
    await new Promise((r) => setTimeout(r, 0));
    expect(container.textContent).toBe('');
  });
});
