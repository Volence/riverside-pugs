import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/preact';
import type { EventListItem } from '../api';

const { mockEvents } = vi.hoisted(() => ({ mockEvents: { list: vi.fn(), get: vi.fn() } }));
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, eventsApi: mockEvents };
});
const { Events } = await import('./Events');
const { ApiError } = await import('../api');

const item = (over: Partial<EventListItem>): EventListItem => ({
  slug: 'cup', name: 'Cup', status: 'announced', entryKind: 'team', official: true, startsAt: '2026-10-10T20:00:00.000Z', bannerKey: null,
  format: ['Swiss', 'Single elimination'], entries: 0, ...over,
});
const session = { kind: 'anonymous' } as const;

afterEach(cleanup);
beforeEach(() => { mockEvents.list.mockReset(); });

describe('Events', () => {
  it('splits upcoming from past, each row a link with its status and format', async () => {
    mockEvents.list.mockResolvedValue({ events: [
      item({ slug: 'spring-cup', name: 'Spring Cup', status: 'registration', entries: 3 }),
      item({ slug: 'old-cup', name: 'Old Cup', status: 'cancelled' }),
    ] });
    render(<Events session={session} />);
    const row = (await screen.findByText('Spring Cup')).closest('a') as HTMLAnchorElement;
    expect(row.getAttribute('href')).toBe('/event/spring-cup');
    expect(screen.getByText('Registration open')).toBeTruthy();
    expect(screen.getAllByText(/Swiss, then Single elimination/)).toHaveLength(2);
    expect(screen.getByText(/3 teams/)).toBeTruthy();
    expect(screen.getByText('Past')).toBeTruthy();
    expect(screen.getByText('Cancelled')).toBeTruthy();
  });

  it('shows a banner thumbnail on a row that has one', async () => {
    mockEvents.list.mockResolvedValue({ events: [item({ name: 'Spring Cup', bannerKey: 'd'.repeat(64) }), item({ slug: 'plain', name: 'Plain Cup' })] });
    const { container } = render(<Events session={session} />);
    await screen.findByText('Spring Cup');
    const thumbs = container.querySelectorAll('img.eventrow__banner');
    expect(thumbs).toHaveLength(1);
    expect(thumbs[0]!.getAttribute('src')).toBe(`/api/events/banners/${'d'.repeat(64)}`);
  });

  it('says nothing is scheduled when there is nothing', async () => {
    mockEvents.list.mockResolvedValue({ events: [] });
    render(<Events session={session} />);
    expect(await screen.findByText('Nothing is scheduled yet.')).toBeTruthy();
    expect(screen.queryByText('Past')).toBeNull();
  });

  it('says events are not open when the switch keeps the viewer out', async () => {
    mockEvents.list.mockRejectedValue(new ApiError(404, 'not found'));
    render(<Events session={session} />);
    expect(await screen.findByText('Events are not open yet.')).toBeTruthy();
  });
});
