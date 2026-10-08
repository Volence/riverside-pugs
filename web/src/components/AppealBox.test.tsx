import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { MyAppeals } from '../api';

const { mock } = vi.hoisted(() => ({ mock: { mine: vi.fn(), file: vi.fn(), message: vi.fn(), signOut: vi.fn() } }));
vi.mock('../api', async (orig) => ({ ...(await orig<typeof import('../api')>()), appealApi: mock }));
const { AppealBox } = await import('./AppealBox');

const base: MyAppeals = { enabled: true, signedInAs: 'steam', name: 'telltale', textMax: 1500, answerMax: 800, items: [] };
const ban = { ref: { kind: 'ban' as const, id: 4 }, hold: false, sanctionKind: null, reason: 'abandon', endsAt: null, canAppeal: true, refusal: null, appeal: null };

beforeEach(() => { for (const f of Object.values(mock)) f.mockReset(); });
afterEach(cleanup);

describe('AppealBox', () => {
  it('falls back to the old line while appeals are off', async () => {
    mock.mine.mockResolvedValue({ ...base, enabled: false });
    render(<AppealBox fallback="To appeal, message an admin in the Discord." />);
    expect(await screen.findByText('To appeal, message an admin in the Discord.')).toBeTruthy();
  });

  it('files an appeal from the two boxes', async () => {
    mock.mine.mockResolvedValue({ ...base, items: [ban] });
    mock.file.mockResolvedValue({ ok: true, id: 1, state: 'open' });
    render(<AppealBox fallback="" />);
    fireEvent.click(await screen.findByText('Appeal this ban'));
    fireEvent.input(screen.getByLabelText('What happened?'), { target: { value: 'lag' } });
    fireEvent.input(screen.getByLabelText('Why should it be lifted or shortened?'), { target: { value: 'router' } });
    fireEvent.click(screen.getByText('Send appeal'));
    await waitFor(() => expect(mock.file).toHaveBeenCalledWith(ban.ref, 'lag', 'router'));
  });

  it('shows the whole conversation, staff unnamed, and sends a reply', async () => {
    mock.mine.mockResolvedValue({ ...base, items: [{ ...ban, canAppeal: false, appeal: {
      id: 9, state: 'asked', answerBy: '2026-10-07T12:00:00.000Z', line: 'Staff have written to you about your appeal.', filedAt: '', canWrite: true,
      messages: [
        { fromStaff: true, body: 'Which map?', at: '2026-10-04T12:00:00.000Z' },
        { fromStaff: false, body: 'Farm 3', at: '2026-10-04T13:00:00.000Z' },
        { fromStaff: true, body: 'Which round?', at: '2026-10-04T14:00:00.000Z' },
      ],
    } }] });
    mock.message.mockResolvedValue({ ok: true });
    render(<AppealBox fallback="" />);
    expect(await screen.findByText('Which map?')).toBeTruthy();
    expect(screen.getByText('Farm 3')).toBeTruthy();
    expect(screen.getByText('Which round?')).toBeTruthy();
    expect(screen.getAllByText(/^Staff ·/)).toHaveLength(2);
    fireEvent.input(screen.getByLabelText('Your reply'), { target: { value: 'Round 2' } });
    fireEvent.click(screen.getByText('Send'));
    await waitFor(() => expect(mock.message).toHaveBeenCalledWith(9, 'Round 2'));
  });

  it('can add to an appeal staff have not answered yet, and no box once it cannot take more', async () => {
    const appeal = { id: 9, state: 'open' as const, answerBy: null, line: 'Your appeal was received. Staff will review it.', filedAt: '', canWrite: true, messages: [] };
    mock.mine.mockResolvedValue({ ...base, items: [{ ...ban, canAppeal: false, appeal }] });
    render(<AppealBox fallback="" />);
    expect(await screen.findByLabelText('Add to your appeal')).toBeTruthy();
    cleanup();
    mock.mine.mockResolvedValue({ ...base, items: [{ ...ban, canAppeal: false, appeal: { ...appeal, canWrite: false } }] });
    render(<AppealBox fallback="" />);
    expect(await screen.findByText('Your appeal was received. Staff will review it.')).toBeTruthy();
    expect(screen.queryByLabelText('Add to your appeal')).toBeNull();
  });

  it('a refusal is shown instead of the button', async () => {
    mock.mine.mockResolvedValue({ ...base, items: [{ ...ban, canAppeal: false, refusal: 'This ban cannot be appealed.' }] });
    render(<AppealBox fallback="" />);
    expect(await screen.findByText('This ban cannot be appealed.')).toBeTruthy();
    expect(screen.queryByText('Appeal this ban')).toBeNull();
  });

  // After a denial in cooldown, the status line and the refusal both say
  // "You can appeal again after X": showing both is a double-up of the same
  // fact, not two different ones.
  it('does not also show the refusal once the status line already says when they can appeal again', async () => {
    const cooldownLine = 'Your appeal was reviewed and the ban stands. You can appeal again after Mon, 10 Oct 2026 12:00:00 UTC.';
    mock.mine.mockResolvedValue({
      ...base,
      items: [{
        ...ban, canAppeal: false,
        refusal: 'Your last appeal for this was turned down. You can appeal again after Mon, 10 Oct 2026 12:00:00 UTC.',
        appeal: { id: 9, state: 'denied', answerBy: null, line: cooldownLine, filedAt: '', messages: [], canWrite: false },
      }],
    });
    render(<AppealBox fallback="" />);
    expect(await screen.findByText(cooldownLine)).toBeTruthy();
    expect(screen.queryByText(/Your last appeal for this was turned down/)).toBeNull();
  });

  it('falls back to the old line when the fetch fails', async () => {
    mock.mine.mockRejectedValue(new Error('boom'));
    render(<AppealBox fallback="To appeal, message an admin in the Discord." />);
    expect(await screen.findByText('To appeal, message an admin in the Discord.')).toBeTruthy();
  });
});
