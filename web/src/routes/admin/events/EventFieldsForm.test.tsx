import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import type { EventFields } from '../../../api';

// toLocalInput/fromLocalInput are not true inverses across a DST fall-back
// repeated hour (fromLocalInput picks the earlier instant). Mocking them to a
// fixed, non-round-tripping pair makes the save-without-touching-start case
// reproducible without depending on the host's time zone or a real DST date.
vi.mock('../../../eventFormat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../eventFormat')>();
  return { ...actual, toLocalInput: () => '2026-11-01T01:30', fromLocalInput: () => '2026-11-01T08:30:00.000Z' };
});
const { EventFieldsForm } = await import('./EventFieldsForm');

const FIELDS: EventFields = {
  name: 'Riverside Cup', startsAt: '2026-11-01T09:30:00.000Z', entryKind: 'team', official: true, teamCap: null, description: '',
  eligibility: { minPugs: 5, requireDiscord: true, srFloor: null, srCeiling: null },
  checkin: { enabled: true, opensMinutes: 60, closesMinutes: 15 },
  roster: { starters: 4, maxSubs: 2, lock: { kind: 'none' }, maxAdditions: null },
};

afterEach(cleanup);

describe('EventFieldsForm start time', () => {
  it('keeps the stored start time exactly when only another field changes', () => {
    const onSave = vi.fn();
    render(<EventFieldsForm fields={FIELDS} status="draft" busy={false} onSave={onSave} />);
    fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'New name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save event' }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ startsAt: FIELDS.startsAt }));
  });

  it('sends the new start time when the start input is changed', () => {
    const onSave = vi.fn();
    render(<EventFieldsForm fields={FIELDS} status="draft" busy={false} onSave={onSave} />);
    fireEvent.input(screen.getByLabelText('Starts at'), { target: { value: '2026-11-01T02:30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save event' }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ startsAt: '2026-11-01T08:30:00.000Z' }));
  });
});
