import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/preact';
import type { StaffChatLine } from '../api';

const chat = vi.fn();
vi.mock('../api', () => ({ peopleApi: { chat: (...a: unknown[]) => chat(...a) } }));

import { StaffChatLog, chatWhen } from './StaffChatLog';

afterEach(() => { cleanup(); chat.mockReset(); });

const line = (seq: number, over: Partial<StaffChatLine>): StaffChatLine => ({
  seq, mapOrdinal: 0, half: 1, tMs: 5000, steamid: '1', player: '1', name: 'alice', team: 'a', message: 'hi', ...over,
});

describe('chatWhen', () => {
  it('says where in the match a line was said, clock or not', () => {
    expect(chatWhen({ mapOrdinal: 0, half: -1, tMs: -1 })).toBe('Map 1, before the first round');
    expect(chatWhen({ mapOrdinal: 1, half: 2, tMs: -1 })).toBe('Map 2, round 2, outside play');
    expect(chatWhen({ mapOrdinal: 0, half: 1, tMs: 65000 })).toBe('Map 1, round 1, 1:05');
  });
});

describe('StaffChatLog', () => {
  const lines = [
    line(1, { half: -1, tMs: -1, steamid: '2', player: '2', name: 'bob', team: 'b', message: 'ready up' }),
    line(2, { message: 'nice' }),
    line(3, { tMs: -1, steamid: '9', player: '1', name: 'alice-alt', message: 'said from the alt' }),
  ];

  it('shows every line with where it was said, including outside a round', async () => {
    chat.mockResolvedValue({ lines });
    render(<StaffChatLog matchId={7} highlight={null} />);
    expect(await screen.findByText('ready up')).toBeTruthy();
    expect(screen.getByText('Map 1, before the first round')).toBeTruthy();
    expect(screen.getByText('Map 1, round 1')).toBeTruthy();
    expect(screen.getByText('Map 1, round 1, outside play')).toBeTruthy();
    expect(screen.getByText('0:05')).toBeTruthy();
    expect(chat).toHaveBeenCalledWith(7, expect.anything());
  });

  it('marks a linked player’s lines, alts included, and can show only theirs', async () => {
    chat.mockResolvedValue({ lines });
    const { container } = render(<StaffChatLog matchId={7} highlight="1" />);
    await screen.findByText('nice');
    expect(container.querySelectorAll('.is-mine')).toHaveLength(2);
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(screen.queryByText('ready up')).toBeNull());
    expect(screen.getByText('said from the alt')).toBeTruthy();
  });

  it('says so when the linked player said nothing', async () => {
    chat.mockResolvedValue({ lines });
    render(<StaffChatLog matchId={7} highlight="5" />);
    expect(await screen.findByText('This player said nothing in this match.')).toBeTruthy();
  });
});
