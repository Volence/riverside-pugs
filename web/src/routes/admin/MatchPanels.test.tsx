import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import type { AdminOverview } from '../../api';
import { ConfirmHost } from '../../components/Confirm';

const { mockAbort } = vi.hoisted(() => ({ mockAbort: vi.fn() }));

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return { ...actual, adminApi: { ...actual.adminApi, abortMatch: mockAbort } };
});

const { OpenMatchesPanel } = await import('./MatchPanels');
const { useAction } = await import('./useAction');

/** Open matches + a confirm host, wired through useAction the way AdminLive
 *  wires it, so abortMatchAsked's dialog and its post-abort notice behave as
 *  they do on the real page. */
function Harness({ open }: { open: AdminOverview['open'] }) {
  const { busy, run } = useAction(() => {});
  return (
    <>
      <OpenMatchesPanel open={open} busy={busy} run={run} />
      <ConfirmHost />
    </>
  );
}

const openMatch = (over: Partial<AdminOverview['open'][number]> = {}): AdminOverview['open'][number] => ({
  id: 10, campaign: 'dead_air', state: 'live', serverId: 1, connected: 7, rostered: 8,
  createdAt: '2026-10-01T19:40:00.000Z', wentLiveAt: '2026-10-01T19:48:00.000Z',
  connect: null, forecast: null,
  roster: [{ steamid: '1', name: 'alice' }, { steamid: '2', name: 'bob' }],
  bookingId: null,
  ...over,
});

beforeEach(() => {
  mockAbort.mockReset();
  mockAbort.mockResolvedValue({ ok: true });
});
afterEach(() => cleanup());

describe('the abort dialog for an ordinary match', () => {
  it('says the server is freed, offers the leave-out boxes, and sends what was ticked', async () => {
    render(<Harness open={[openMatch()]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Abort' }));
    const dialog = await waitFor(() => screen.getByRole('alertdialog'));
    expect(dialog.textContent).toContain('The server is freed');
    expect(dialog.textContent).not.toContain('booking');
    expect(within(dialog).getAllByRole('checkbox')).toHaveLength(2);
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Leave bob out/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Abort match' }));
    await waitFor(() => expect(mockAbort).toHaveBeenCalledWith(10, ['2']));
  });

  it('shows nothing extra after the abort, since the route sends no message', async () => {
    render(<Harness open={[openMatch()]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Abort' }));
    const dialog = await waitFor(() => screen.getByRole('alertdialog'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Abort match' }));
    await waitFor(() => expect(mockAbort).toHaveBeenCalled());
    expect(screen.queryByText(/booking/)).toBeNull();
  });
});

describe('the abort dialog for a booking game', () => {
  it('says the booking carries on, offers no leave-out boxes, sends no leaveOut, and shows the route\'s message after', async () => {
    const message = 'This was a booking game: it is aborted and the booking continues on its server.';
    mockAbort.mockResolvedValue({ ok: true, message });
    render(<Harness open={[openMatch({ bookingId: 5, roster: [{ steamid: '1', name: 'alice' }] })]} />);

    fireEvent.click(screen.getByRole('button', { name: 'Abort' }));
    const dialog = await waitFor(() => screen.getByRole('alertdialog'));
    expect(dialog.textContent).toContain('The game is dropped; the booking keeps its server and carries on.');
    expect(dialog.textContent).not.toContain('The server is freed');
    expect(within(dialog).queryAllByRole('checkbox')).toHaveLength(0);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Abort match' }));
    await waitFor(() => expect(mockAbort).toHaveBeenCalledWith(10, []));
    expect(await screen.findByText(message)).toBeTruthy();
  });
});
