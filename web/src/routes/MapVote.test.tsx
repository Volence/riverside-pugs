import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/preact';
import { MapVote } from './Play';
import type { LobbySnapshot } from '../api';

afterEach(cleanup);

const lobby = (over: Partial<LobbySnapshot> = {}): LobbySnapshot => ({
  id: 'lob_1', phase: 'map_vote', players: [], ready: [], options: ['no_mercy', 'the_parish'],
  votes: {}, deadline: Date.now() + 30_000, myVote: null, ...over,
});

describe('MapVote download marks', () => {
  it('marks only the options in downloads, and says voting is still open', () => {
    render(<MapVote lobby={lobby({ downloads: ['the_parish'] })} refresh={() => {}} />);
    const marks = screen.getAllByText('Download');
    expect(marks).toHaveLength(1);
    const tile = marks[0].closest('button') as HTMLButtonElement;
    expect(tile.textContent).toContain('the_parish');
    // A mark, not a restriction: the tile is still a live button.
    expect(tile.disabled).toBe(false);
    expect(screen.getByText(/You can still vote for it/)).toBeTruthy();
  });

  it('shows no marks without downloads (the every-campaign vote)', () => {
    render(<MapVote lobby={lobby()} refresh={() => {}} />);
    expect(screen.queryByText('Download')).toBeNull();
    expect(screen.queryByText(/You can still vote for it/)).toBeNull();
  });
});
