import { describe, it, expect } from 'vitest';
import { deskSteps } from './deskSteps';

type Ev = Parameters<typeof deskSteps>[0];
const ev = (o: Partial<Ev> & { kind?: 'draft' | 'team'; actions?: string[] }): Ev => ({
  status: o.status ?? 'draft',
  fields: { entryKind: o.kind ?? 'draft' } as Ev['fields'],
  cutAt: o.cutAt ?? null,
  teamsMadeAt: o.teamsMadeAt ?? null,
  log: (o.actions ?? []).map((action) => ({ at: '2026-10-23T00:00:00.000Z', actorName: null, action, detail: {} })),
});
const now = (e: Ev) => deskSteps(e).find((s) => s.state === 'now')?.key;

describe('deskSteps', () => {
  it('walks a draft event from publish to finish', () => {
    expect(now(ev({}))).toBe('publish');
    expect(now(ev({ status: 'announced' }))).toBe('open');
    expect(now(ev({ status: 'registration' }))).toBe('close');
    expect(now(ev({ status: 'registration', actions: ['draft_signups_closed'] }))).toBe('captains');
    expect(now(ev({ status: 'registration', actions: ['draft_signups_closed', 'draft_captains_picked'] }))).toBe('cut');
    expect(now(ev({ status: 'registration', cutAt: 'x' }))).toBe('teams');
    expect(now(ev({ status: 'registration', cutAt: 'x', teamsMadeAt: 'y' }))).toBe('start');
    expect(now(ev({ status: 'live', cutAt: 'x', teamsMadeAt: 'y' }))).toBe('finish');
    expect(now(ev({ status: 'finished', cutAt: 'x', teamsMadeAt: 'y' }))).toBeUndefined();
  });

  it('marks earlier steps done and later ones later, with one step lit', () => {
    const steps = deskSteps(ev({ status: 'registration', cutAt: 'x' }));
    expect(steps.map((s) => s.state)).toEqual(['done', 'done', 'done', 'done', 'done', 'now', 'later', 'later']);
    expect(steps.find((s) => s.state === 'now')!.anchor).toBe('evdesk-teams');
  });

  it('walks a team event through the entry list', () => {
    expect(deskSteps(ev({ kind: 'team' })).map((s) => s.key)).toEqual(['publish', 'open', 'lock', 'start', 'finish']);
    expect(now(ev({ kind: 'team', status: 'registration' }))).toBe('lock');
    expect(now(ev({ kind: 'team', status: 'registration', actions: ['entries_locked'] }))).toBe('start');
  });

  it('lights nothing on a cancelled event', () => {
    expect(now(ev({ status: 'cancelled' }))).toBeUndefined();
  });
});
