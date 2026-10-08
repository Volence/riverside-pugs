import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/preact';
import { DraftOnAir } from './CastStudio';
import { defaultStudioState, type StudioState } from '../../../src/cast/types';
import type { StudioPickDraft } from '../api';

/** Drafts plan D2b2 Rulings 1 and 4. */
const drafts: StudioPickDraft[] = [{ id: 4, name: 'Draft Night', slug: 'draft-night', status: 'running', picks: 7, totalPicks: 15 }];

describe('studio: draft on air', () => {
  afterEach(cleanup);

  it('lists followable drafts and toggles one on and off, leaving the match alone', () => {
    let state: StudioState = { ...defaultStudioState(), matchId: 9 };
    const update = vi.fn((fn: (s: StudioState) => StudioState) => { state = fn(state); });
    const { getByRole, rerender } = render(<DraftOnAir drafts={drafts} state={state} update={update} />);
    const button = () => getByRole('button', { name: /Draft Night/ });
    expect(button().textContent).toContain('7 of 15 picks');
    fireEvent.click(button());
    expect(state).toMatchObject({ draftEventId: 4, matchId: 9 });
    rerender(<DraftOnAir drafts={drafts} state={state} update={update} />);
    expect(button().getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(button());
    expect(state.draftEventId).toBeNull();
    expect(state.matchId).toBe(9);
  });

  it('says how a draft gets here when there is none, and turns the strip off', () => {
    let state = defaultStudioState();
    const update = vi.fn((fn: (s: StudioState) => StudioState) => { state = fn(state); });
    const { getByText, getByRole } = render(<DraftOnAir drafts={[]} state={state} update={update} />);
    expect(getByText(/No live draft to follow/)).toBeTruthy();
    fireEvent.change(getByRole('checkbox'), { target: { checked: false } });
    expect(state.draftStrip).toBe(false);
  });

  it('shows a saved draft that left the list as off air, with a way to clear it', () => {
    let state: StudioState = { ...defaultStudioState(), draftEventId: 12 };
    const update = vi.fn((fn: (s: StudioState) => StudioState) => { state = fn(state); });
    const { getByText, getByRole } = render(<DraftOnAir drafts={drafts} state={state} update={update} />);
    expect(getByText('Off air')).toBeTruthy();
    fireEvent.click(getByRole('button', { name: 'Clear' }));
    expect(state.draftEventId).toBeNull();
  });
});
