import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import type { TicketEvent, TicketMessage } from '../../api';
import { ConfirmHost } from '../../components/Confirm';
import { useAction } from './useAction';

const { mockMod } = vi.hoisted(() => ({ mockMod: { removeMessage: vi.fn() } }));
vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return { ...actual, modApi: { ...actual.modApi, ...mockMod } };
});

const { TicketTimeline, interleave } = await import('./TicketTimeline');

const event = (id: number, kind: string, createdAt: string, over: Partial<TicketEvent> = {}): TicketEvent =>
  ({ id, actorId: '1', actorName: 'Mod', kind, detail: {}, createdAt, ...over });
const message = (id: number, createdAt: string, over: Partial<TicketMessage> = {}): TicketMessage => ({
  id, channel: 'staff', authorName: 'Mod on Discord', authorPlayerId: '1', authorPlayerName: 'Mod', content: `message ${id}`, history: [],
  createdAt, editedAt: null, deletedAt: null, removed: null, attachments: [], ...over,
});
const png = { id: 5, filename: 'shot.png', contentType: 'image/png', size: 2048, sha256: 'ab'.repeat(32), stored: true, skipReason: null, removed: false };

let reloads = 0;
function Harness({ events, messages }: { events: TicketEvent[]; messages: TicketMessage[] }) {
  const { busy, run } = useAction(() => { reloads++; });
  return <><TicketTimeline ticketId={12} events={events} messages={messages} busy={busy} run={run} /><ConfirmHost /></>;
}

afterEach(cleanup);
beforeEach(() => { mockMod.removeMessage.mockReset(); mockMod.removeMessage.mockResolvedValue({ ok: true }); reloads = 0; });

describe('TicketTimeline', () => {
  it('puts events and messages in one list, in time order, and labels each message', () => {
    const items = interleave(
      [event(1, 'opened', '2026-09-22T10:00:00.000Z'), event(2, 'claimed', '2026-09-22T10:05:00.000Z')],
      [message(1, '2026-09-22T10:02:00.000Z'), message(2, '2026-09-22T10:07:00.000Z', { channel: 'reporter' })],
    );
    expect(items.map((i) => i.key)).toEqual(['e1', 'm1', 'e2', 'm2']);
    render(<Harness events={[event(2, 'claimed', '2026-09-22T10:05:00.000Z')]} messages={[message(1, '2026-09-22T10:02:00.000Z'), message(2, '2026-09-22T10:07:00.000Z', { channel: 'reporter' })]} />);
    const rows = screen.getAllByRole('listitem').map((li) => li.textContent ?? '');
    expect(rows[0]).toContain('staff');
    expect(rows[0]).toContain('message 1');
    expect(rows[1]).toContain('Mod claimed it');
    expect(rows[2]).toContain('reporter');
  });

  it('shows a staff file as a thumbnail at once, and says why a file was not kept', () => {
    render(<Harness events={[]} messages={[message(1, '2026-09-22T10:02:00.000Z', { attachments: [
      png, { ...png, id: 6, filename: 'tool.exe', stored: false, skipReason: 'type', sha256: null },
    ] })]} />);
    const img = screen.getByAltText('shot.png') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('/api/mod/tickets/12/attachments/5');
    expect(img.closest('a')!.getAttribute('target')).toBe('_blank');
    expect(screen.getByText(/tool\.exe/).textContent).toMatch(/not stored: this type of file is not stored/);
  });

  it('never loads a file from the reporter channel until a moderator asks to see it', () => {
    render(<Harness events={[]} messages={[message(1, '2026-09-22T10:02:00.000Z', { channel: 'reporter', attachments: [png] })]} />);
    expect(screen.queryByAltText('shot.png')).toBeNull();
    expect(document.querySelector('img, video')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show 1 file from the reporter' }));
    expect((screen.getByAltText('shot.png') as HTMLImageElement).getAttribute('src')).toBe('/api/mod/tickets/12/attachments/5');
  });

  it('keeps an edited message\'s earlier versions to hand, and marks one deleted in Discord', () => {
    render(<Harness events={[]} messages={[message(1, '2026-09-22T10:02:00.000Z', {
      content: 'the polite version', history: ['the first version'], editedAt: '2026-09-22T10:03:00.000Z', deletedAt: '2026-09-22T10:04:00.000Z',
    })]} />);
    expect(screen.getByText('the polite version')).toBeTruthy();
    expect(screen.getByText('1 earlier version')).toBeTruthy();
    expect(screen.getByText('the first version')).toBeTruthy();
    expect(screen.getByText(/deleted in Discord/)).toBeTruthy();
  });

  it('Remove asks once, says it cannot be undone, and sends the reason', async () => {
    render(<Harness events={[]} messages={[message(7, '2026-09-22T10:02:00.000Z', { attachments: [png] })]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    const first = await waitFor(() => screen.getByRole('alertdialog'));
    expect(first.textContent).toMatch(/cannot be undone/);
    fireEvent.click(within(first).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(mockMod.removeMessage).not.toHaveBeenCalled();

    fireEvent.input(screen.getByLabelText('Reason for a removal'), { target: { value: 'gore' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    const second = await waitFor(() => screen.getByRole('alertdialog'));
    fireEvent.click(within(second).getByRole('button', { name: 'Remove for good' }));
    await waitFor(() => expect(mockMod.removeMessage).toHaveBeenCalledWith(12, 7, 'gore'));
    await waitFor(() => expect(reloads).toBe(1));
  });

  it('still asks before showing a removed reporter file\'s name, which the reporter chose', () => {
    render(<Harness events={[]} messages={[message(7, '2026-09-22T10:02:00.000Z', {
      channel: 'reporter', content: '', history: [], removed: { at: '2026-09-22T12:00:00.000Z', by: '1', byName: 'Mod', reason: 'gore' },
      attachments: [{ ...png, stored: false, removed: true }],
    })]} />);
    expect(screen.queryByText(/shot\.png/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show 1 file from the reporter' }));
    const shown = screen.getByText(/shot\.png/).textContent ?? '';
    expect(shown).toContain('2.0 KB');
    expect(shown).toContain('abababababababab');
  });

  it('a removed message is a tombstone: who, when, why, the file\'s name, size and hash, and nothing to click', () => {
    render(<Harness events={[]} messages={[message(7, '2026-09-22T10:02:00.000Z', {
      content: '', history: [], removed: { at: '2026-09-22T12:00:00.000Z', by: '1', byName: 'Mod', reason: 'gore' },
      attachments: [{ ...png, stored: false, removed: true }],
    })]} />);
    const row = screen.getByRole('listitem').textContent ?? '';
    expect(row).toMatch(/Removed by Mod/);
    expect(row).toContain('gore');
    expect(row).toContain('shot.png');
    expect(row).toContain('2.0 KB');
    expect(row).toContain('abababababababab');
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
    // The author's profile link is still there; nothing points at a file.
    expect(document.querySelector('img, video, a[href*="attachments"]')).toBeNull();
  });
});
