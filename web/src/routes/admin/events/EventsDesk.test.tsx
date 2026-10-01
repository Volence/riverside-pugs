import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { AdminEventRow } from '../../../api';

const { mockAdmin } = vi.hoisted(() => ({ mockAdmin: { events: vi.fn(), createEvent: vi.fn() } }));
vi.mock('../../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api')>();
  return { ...actual, adminApi: { ...actual.adminApi, ...mockAdmin } };
});
const { EventsDesk } = await import('./EventsDesk');
const { LocationProvider } = await import('preact-iso');

const ROW: AdminEventRow = {
  id: 3, slug: 'riverside-cup', name: 'Riverside Cup', status: 'draft', entryKind: 'team',
  startsAt: '2026-10-10T20:00:00.000Z', stages: 2, updatedAt: '2026-10-01T12:00:00.000Z',
};

afterEach(() => { cleanup(); history.replaceState(null, '', '/'); });
beforeEach(() => { for (const f of Object.values(mockAdmin)) f.mockReset(); });

const show = (canEdit = true) => render(<LocationProvider><EventsDesk canEdit={canEdit} /></LocationProvider>);

describe('EventsDesk', () => {
  it('lists every event with its status and stage count, each a link to its editor', async () => {
    mockAdmin.events.mockResolvedValue({ events: [ROW] });
    show();
    const name = await screen.findByText('Riverside Cup');
    expect((name.closest('a') as HTMLAnchorElement).getAttribute('href')).toBe('/admin/events/3');
    expect(screen.getByText('Draft')).toBeTruthy();
    expect(screen.getByText(/2 stages/)).toBeTruthy();
  });

  it('creates a draft from the name, the local start and the kind, then opens it', async () => {
    mockAdmin.events.mockResolvedValue({ events: [] });
    mockAdmin.createEvent.mockResolvedValue({ id: 7, slug: 'spring-cup' });
    show();
    await screen.findByText('No events yet.');
    fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'Spring Cup' } });
    fireEvent.input(screen.getByLabelText('Starts at'), { target: { value: '2026-10-10T20:00' } });
    fireEvent.change(screen.getByLabelText('Entry kind'), { target: { value: 'draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));
    await waitFor(() => expect(mockAdmin.createEvent).toHaveBeenCalledWith({
      name: 'Spring Cup', startsAt: new Date('2026-10-10T20:00').toISOString(), entryKind: 'draft',
    }));
    await waitFor(() => expect(location.pathname).toBe('/admin/events/7'));
  });

  it('a mod reads the list with no create form', async () => {
    mockAdmin.events.mockResolvedValue({ events: [ROW] });
    show(false);
    expect(await screen.findByText('Riverside Cup')).toBeTruthy();
    expect(screen.queryByText('New event')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create draft' })).toBeNull();
  });

  it('asks for a start time instead of sending none', async () => {
    mockAdmin.events.mockResolvedValue({ events: [] });
    show();
    await screen.findByText('No events yet.');
    expect(screen.getByText(/a draft only staff can see/)).toBeTruthy();
    fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'Spring Cup' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));
    expect(await screen.findByText('Pick a start time.')).toBeTruthy();
    expect(mockAdmin.createEvent).not.toHaveBeenCalled();
  });
});
