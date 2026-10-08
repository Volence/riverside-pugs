import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/preact';
import { defaultStudioState, type StudioState } from '../../../src/cast/types';

/** Final review of drafts plan D2b2: a draft that goes off air must not jam
 *  every later save. The server clears a saved draft that is no longer
 *  castable (Ruling 10) but refuses one chosen anew with not_castable_draft. */

const { mockStudio, mockCast } = vi.hoisted(() => ({
  mockStudio: { get: vi.fn(), save: vi.fn(), feed: vi.fn(), callout: vi.fn(), clearCallout: vi.fn(), newKey: vi.fn(), prep: vi.fn() },
  mockCast: { list: vi.fn() },
}));
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, studioApi: mockStudio, castApi: mockCast };
});
const { ApiError } = await import('../api');
const { default: CastStudio } = await import('./CastStudio');

const panel = (studio: StudioState, drafts: { id: number }[] = []) => ({
  studio, rev: 1, key: 'k', matches: [], bookings: [], obsScenes: {},
  drafts: drafts.map((d) => ({ id: d.id, name: `Draft ${d.id}`, slug: `d${d.id}`, status: 'running', picks: 1, totalPicks: 15 })),
});

const sent = () => mockStudio.save.mock.calls.map((c) => c[0] as StudioState);

describe('studio: saving after a draft goes off air', () => {
  beforeEach(() => {
    mockCast.list.mockResolvedValue({ matches: [] });
    mockStudio.feed.mockRejectedValue(new Error('offline'));
    // The panel loads the overlays' font itself: keep jsdom off the network.
    if (!document.getElementById('studio-stencil-font')) {
      const l = document.createElement('link');
      l.id = 'studio-stencil-font';
      document.head.appendChild(l);
    }
  });
  afterEach(() => { cleanup(); vi.resetAllMocks(); });

  it('takes the cleared draft from the server, so the next save does not resend it', async () => {
    mockStudio.get.mockResolvedValue(panel({ ...defaultStudioState(), draftEventId: 4 }));
    // Save 1: the draft passed its window, so the server clears it quietly.
    // Any later save that still names draft 4 is refused, as the server does.
    mockStudio.save.mockImplementation(async (s: StudioState) => {
      if (mockStudio.save.mock.calls.length > 1 && s.draftEventId === 4) throw new ApiError(403, 'not_castable_draft');
      return { studio: { ...s, draftEventId: null }, rev: 2 };
    });
    const { findByRole, getByRole, queryByRole } = render(<CastStudio />);
    fireEvent.click(await findByRole('button', { name: /Casters/ }));
    await waitFor(() => expect(mockStudio.save).toHaveBeenCalledTimes(1));
    fireEvent.click(getByRole('button', { name: /Be right back/ }));
    await waitFor(() => expect(mockStudio.save).toHaveBeenCalledTimes(2));
    expect(sent()[1]).toMatchObject({ scene: 'brb', draftEventId: null });
    await waitFor(() => expect(queryByRole('alert')).toBeNull());
  });

  it('falls back to the last saved draft when a newly chosen one is refused, and saves the scene cut again', async () => {
    mockStudio.get.mockResolvedValue(panel(defaultStudioState(), [{ id: 4 }]));
    mockStudio.save.mockImplementation(async (s: StudioState) => {
      if (s.draftEventId === 4) throw new ApiError(403, 'not_castable_draft');
      return { studio: s, rev: 2 };
    });
    const { findByRole, getByRole } = render(<CastStudio />);
    // The draft went off air during the 15 s poll, so the list is stale.
    fireEvent.click(await findByRole('button', { name: /Draft 4/ }));
    fireEvent.click(getByRole('button', { name: /Be right back/ }));
    await waitFor(() => expect(mockStudio.save).toHaveBeenCalledTimes(2));
    expect(sent()[0]).toMatchObject({ scene: 'brb', draftEventId: 4 });
    expect(sent()[1]).toMatchObject({ scene: 'brb', draftEventId: null });
    expect(getByRole('button', { name: /Draft 4/ }).getAttribute('aria-pressed')).toBe('false');
    // A later save goes through too.
    fireEvent.click(getByRole('button', { name: /Casters/ }));
    await waitFor(() => expect(mockStudio.save).toHaveBeenCalledTimes(3));
    expect(sent()[2]).toMatchObject({ scene: 'casters', draftEventId: null });
  });
});
