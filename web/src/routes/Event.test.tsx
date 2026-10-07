import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/preact';
import type { EventView } from '../api';

const { mockEvents } = vi.hoisted(() => ({ mockEvents: { list: vi.fn(), get: vi.fn(), mine: vi.fn() } }));
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, eventsApi: mockEvents };
});
const { EventPage } = await import('./Event');
const { ApiError } = await import('../api');

const inMinutes = (m: number) => new Date(Date.now() + m * 60_000 + 30_000).toISOString();
const view = (over: Partial<EventView> = {}): EventView => ({
  slug: 'riverside-cup', name: 'Riverside Cup', status: 'announced', entryKind: 'team', official: true, organizerName: 'boss',
  bannerKey: null, startsAt: inMinutes((2 * 24 + 3) * 60), description: '', teamCap: 16,
  eligibility: { minPugs: 5, requireDiscord: true, srFloor: null, srCeiling: 2500 },
  checkin: { enabled: true, opensMinutes: 60, closesMinutes: 15 },
  roster: { starters: 4, maxSubs: 2, lock: { kind: 'none' }, maxAdditions: null },
  stages: [
    {
      ordinal: 1, type: 'swiss', summary: 'Swiss, 4 rounds, top 8 advance', veto: 'Ban to one (Bo1)', chapters: 'Every chapter but the finale',
      scheduling: 'rolling', rulesetName: 'Standard Cup', rules: ['No-show grace: 15 minutes', 'Higher seed picks sides'], gameConfig: 'Standard',
      campaigns: [{ slug: 'no_mercy', name: 'No Mercy' }, { slug: 'dead_air', name: 'Dead Air' }],
    },
    {
      ordinal: 2, type: 'single_elim', summary: 'Single elimination, third-place match', veto: 'Ban to one (Bo1)', chapters: '3 chapters',
      scheduling: 'rolling', rulesetName: 'Standard Cup', rules: [], gameConfig: 'Standard', campaigns: [{ slug: 'dead_air', name: 'Dead Air' }],
    },
  ],
  entries: [], play: [], finishedAt: null, cancelledAt: null, cancelReason: null,
  lockedAt: null, checkinOpensAt: null, checkinClosesAt: null,
  ...over,
});
const session = { kind: 'anonymous' } as const;

afterEach(cleanup);
beforeEach(() => {
  mockEvents.get.mockReset();
  mockEvents.mine.mockReset();
  mockEvents.mine.mockResolvedValue({ entries: [], register: [], canRegister: false });
});

describe('EventPage', () => {
  it('shows the status, the countdown, the format strip, rules and pools, entry rules and no teams yet', async () => {
    mockEvents.get.mockResolvedValue(view());
    render(<EventPage slug="riverside-cup" session={session} />);
    expect(await screen.findByText('Riverside Cup')).toBeTruthy();
    expect(screen.getByText('Official event')).toBeTruthy();
    expect(screen.getByText('Announced')).toBeTruthy();
    expect(screen.getByText(/in 2 days 3 h/)).toBeTruthy();
    expect(screen.getAllByText('Swiss, 4 rounds, top 8 advance').length).toBeGreaterThan(0);
    expect(screen.getByText('Single elimination, third-place match')).toBeTruthy();
    expect(screen.getByText('Higher seed picks sides')).toBeTruthy();
    expect(screen.getAllByText('Dead Air')).toHaveLength(2);
    expect(screen.getByText('At least 5 completed PUGs, account in good standing')).toBeTruthy();
    expect(screen.getByText('SR 2500 or less')).toBeTruthy();
    expect(screen.getByText('4 starters and up to 2 subs')).toBeTruthy();
    expect(screen.getByText('Up to 16 teams')).toBeTruthy();
    expect(screen.getByText('Check-in opens 60 minutes before the start and closes 15 minutes before')).toBeTruthy();
    expect(screen.getByText('No teams have entered yet.')).toBeTruthy();
  });

  it('formats the description with the safe subset, and shows HTML in it as text', async () => {
    mockEvents.get.mockResolvedValue(view({ description: '## Rules\n**Be on time.** <b>two</b>\n[Discord](javascript:alert(1))' }));
    const { container } = render(<EventPage slug="riverside-cup" session={session} />);
    await screen.findByText('Riverside Cup');
    const desc = container.querySelector('.eventdesc') as HTMLElement;
    expect(desc.querySelector('h4')?.textContent).toBe('Rules');
    expect(desc.querySelector('strong')?.textContent).toBe('Be on time.');
    expect(desc.querySelector('b')).toBeNull();
    expect(desc.querySelector('a')).toBeNull();
    expect(desc.textContent).toContain('<b>two</b>');
    expect(desc.textContent).toContain('[Discord](javascript:alert(1))');
  });

  it('shows the banner above the header when the event has one', async () => {
    mockEvents.get.mockResolvedValue(view({ bannerKey: 'c'.repeat(64) }));
    const { container } = render(<EventPage slug="riverside-cup" session={session} />);
    await screen.findByText('Riverside Cup');
    expect((container.querySelector('img.eventbanner') as HTMLImageElement).getAttribute('src')).toBe(`/api/events/banners/${'c'.repeat(64)}`);
  });

  it('a draft-kind event shows the signup count and names before the cut, and never SR, notes or preferences', async () => {
    mockEvents.get.mockResolvedValue(view({
      entryKind: 'draft', status: 'registration',
      draft: { signupsCloseAt: inMinutes(60), draftAt: inMinutes(120), signups: 3, names: ['Alice', 'Bob', 'Cy'], cut: null },
      checkinOpensAt: inMinutes(150), checkinClosesAt: inMinutes(170),
    }));
    const { container } = render(<EventPage slug="riverside-cup" session={session} />);
    expect(await screen.findByText('3 signed up')).toBeTruthy();
    expect(container.textContent).not.toMatch(/check-in/i);
    expect(screen.getByText(/Signups close/)).toBeTruthy();
    expect(screen.getByText(/Draft night/)).toBeTruthy();
    for (const n of ['Alice', 'Bob', 'Cy']) expect(screen.getByText(n)).toBeTruthy();
    expect(screen.queryByText('Captains')).toBeNull();
    expect(screen.queryByText('Draft event: individual signups open later.')).toBeNull();
    expect(container.textContent).not.toMatch(/captainPref|willing|captain|prefer|note/i);
    expect(screen.queryByText('Up to 16 teams')).toBeNull();
  });

  it('a published cut shows Captains, Pool and Bench as names only', async () => {
    mockEvents.get.mockResolvedValue(view({
      entryKind: 'draft', status: 'registration',
      draft: {
        signupsCloseAt: inMinutes(-60), draftAt: inMinutes(120), signups: 5, names: ['Alice', 'Bob', 'Cy', 'Di', 'Ed'],
        cut: { captains: ['Alice'], pool: ['Bob', 'Cy', 'Di'], bench: ['Ed'] },
      },
    }));
    render(<EventPage slug="riverside-cup" session={session} />);
    expect(await screen.findByText('Captains')).toBeTruthy();
    expect(screen.getByText('Pool')).toBeTruthy();
    expect(screen.getByText('Bench')).toBeTruthy();
    expect(screen.getAllByText('Alice')).toHaveLength(1);
    expect(screen.getByText('Ed')).toBeTruthy();
    expect(screen.queryByText(/signed up/)).toBeNull();
  });

  it('a cancelled event says so, with the reason, and no countdown', async () => {
    mockEvents.get.mockResolvedValue(view({ status: 'cancelled', cancelReason: 'Not enough teams' }));
    render(<EventPage slug="riverside-cup" session={session} />);
    expect(await screen.findByText('This event was cancelled: Not enough teams')).toBeTruthy();
    expect(screen.queryByText(/in 2 days/)).toBeNull();
  });

  it('a draft event with its teams made lists the teams with logos, keeps the cut lists, and shows no check-in or SR', async () => {
    mockEvents.get.mockResolvedValue(view({
      entryKind: 'draft', status: 'registration', lockedAt: inMinutes(-60), eligibility: { minPugs: 5, requireDiscord: true, srFloor: null, srCeiling: null },
      draft: {
        signupsCloseAt: inMinutes(-60), draftAt: inMinutes(120), signups: 6, names: ['Ann', 'Bob'],
        cut: { captains: ['Ann', 'Eve'], pool: ['Bob', 'Cy'], bench: ['Di'] },
      },
      entries: [
        { id: 1, name: 'Team Ann', tag: 'ANN', logoKey: 'abc', seed: 1, status: 'checked_in', waitlist: null, placement: null },
        { id: 2, name: 'Team Eve', tag: '', logoKey: null, seed: 2, status: 'checked_in', waitlist: null, placement: null },
      ],
    }));
    const { container } = render(<EventPage slug="riverside-cup" session={session} />);
    expect(await screen.findByRole('heading', { name: 'Teams' })).toBeTruthy();
    expect(screen.getByText('Team Ann')).toBeTruthy();
    expect(screen.getByText('Team Eve')).toBeTruthy();
    expect(container.querySelector('img.evententry__logo')?.getAttribute('src')).toBe('/api/events/logos/abc.png');
    expect(screen.getByRole('heading', { name: 'Captains' })).toBeTruthy();
    expect(screen.queryByText('Checked in')).toBeNull();
    expect(container.textContent).not.toMatch(/\bSR\b(?! \d+ (or|to))|forecast|spread|average/i);
    expect(container.textContent).not.toMatch(/\d{3,4} SR|SR \d{3,4}/);
  });

  it('a draft event before its teams are made shows no Teams list', async () => {
    mockEvents.get.mockResolvedValue(view({ entryKind: 'draft', status: 'registration', draft: { signupsCloseAt: inMinutes(60), draftAt: inMinutes(120), signups: 1, names: ['Ann'], cut: null } }));
    render(<EventPage slug="riverside-cup" session={session} />);
    await screen.findByText('Riverside Cup');
    expect(screen.queryByRole('heading', { name: 'Teams' })).toBeNull();
  });

  it('shows a draft captain their identity panel', async () => {
    mockEvents.get.mockResolvedValue(view({
      entryKind: 'draft', status: 'registration',
      draft: { signupsCloseAt: inMinutes(-60), draftAt: inMinutes(120), signups: 6, names: [], cut: { captains: ['Ann'], pool: [], bench: [] } },
    }));
    mockEvents.mine.mockResolvedValue({ entries: [], register: [], canRegister: false, signup: null, offer: null, captainOf: { entryId: 1, name: 'Team Ann', tag: '', logoKey: null, editable: true } });
    render(<EventPage slug="riverside-cup" session={{ kind: 'active' } as never} />);
    expect(await screen.findByRole('heading', { name: 'Your team' })).toBeTruthy();
    expect((screen.getByLabelText('Team name') as HTMLInputElement).value).toBe('Team Ann');
  });

  it('a draft staff preview is marked as such', async () => {
    mockEvents.get.mockResolvedValue(view({ status: 'draft' }));
    render(<EventPage slug="riverside-cup" session={session} />);
    expect(await screen.findByText('Draft: only staff can see this page.')).toBeTruthy();
  });

  it('an unknown event, or a closed switch, is the missing state', async () => {
    mockEvents.get.mockRejectedValue(new ApiError(404, 'not found'));
    render(<EventPage slug="nope" session={session} />);
    expect(await screen.findByText('No such event, or events are not open yet.')).toBeTruthy();
  });

  it('says it could not load on any other failure, instead of staying blank', async () => {
    mockEvents.get.mockRejectedValue(new ApiError(500, 'boom'));
    render(<EventPage slug="riverside-cup" session={session} />);
    expect((await screen.findByRole('alert')).textContent).toBe('Could not load this event. Try again in a moment.');
  });

  it('marks a waitlisted entry', async () => {
    mockEvents.get.mockResolvedValue(view({
      entries: [{ id: 1, name: 'Rats', tag: 'RAT', logoKey: null, seed: null, status: 'registered', waitlist: 2, placement: null }],
    }));
    render(<EventPage slug="riverside-cup" session={session} />);
    expect(await screen.findByText('Waitlist 2')).toBeTruthy();
  });

  it('marks a checked-in entry', async () => {
    mockEvents.get.mockResolvedValue(view({
      entries: [{ id: 1, name: 'Rats', tag: 'RAT', logoKey: null, seed: null, status: 'checked_in', waitlist: null, placement: null }],
    }));
    render(<EventPage slug="riverside-cup" session={session} />);
    expect(await screen.findByText('Checked in')).toBeTruthy();
  });

  it('shows a live stage and the placements of a finished event', async () => {
    mockEvents.get.mockResolvedValue(view({
      status: 'finished',
      entries: [{ id: 1, name: 'Rats', tag: 'RAT', logoKey: null, seed: 1, status: 'placed', waitlist: null, placement: 1 }],
      play: [{ ordinal: 1, type: 'single_elim', status: 'finished', layout: 'bracket', groups: [{ number: 1, label: 'Bracket' }], standings: [], advanceCount: null, pairsAsItGoes: false,
        rounds: [{ group: 1, round: 1, label: 'Final', dates: null, defaultAt: null, window: null, matches: [] }] }],
    }));
    render(<EventPage slug="riverside-cup" session={session} />);
    expect(await screen.findByText(/Stage 1: bracket/)).toBeTruthy();
    expect(screen.getByText('1st')).toBeTruthy();
  });
});
