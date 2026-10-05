import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { MyAppeals } from '../api';

const { mock } = vi.hoisted(() => ({ mock: { mine: vi.fn(), file: vi.fn(), answer: vi.fn(), signOut: vi.fn() } }));
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

  it('shows the one question with an answer box', async () => {
    mock.mine.mockResolvedValue({ ...base, items: [{ ...ban, canAppeal: false, appeal: { id: 9, state: 'asked', question: 'Which map?', answerBy: '2026-10-07T12:00:00.000Z', line: 'Staff have one question about your appeal.', filedAt: '' } }] });
    render(<AppealBox fallback="" />);
    expect(await screen.findByText('Which map?')).toBeTruthy();
    expect(screen.getByLabelText('Your answer')).toBeTruthy();
  });

  it('a refusal is shown instead of the button', async () => {
    mock.mine.mockResolvedValue({ ...base, items: [{ ...ban, canAppeal: false, refusal: 'This ban cannot be appealed.' }] });
    render(<AppealBox fallback="" />);
    expect(await screen.findByText('This ban cannot be appealed.')).toBeTruthy();
    expect(screen.queryByText('Appeal this ban')).toBeNull();
  });
});
