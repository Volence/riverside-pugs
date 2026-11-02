import type { AdminEventDetail } from '../../../api';

/** One step of the desk's "what's next" strip. `where` names the panel that
 *  holds the step's button, and `anchor` is that panel's id on the page. */
export interface DeskStep {
  key: string; label: string; where: string; anchor: string;
  state: 'done' | 'now' | 'later';
}

/**
 * The run of an event as staff work through it, read from what the desk
 * already has: the status, the cut and teams stamps, and the history. Nothing
 * here decides anything; it only says which step the event has reached, so
 * the strip can light the next one. A cancelled event has no next step.
 */
export function deskSteps(ev: Pick<AdminEventDetail, 'status' | 'fields' | 'cutAt' | 'teamsMadeAt' | 'log'>): DeskStep[] {
  const logged = (action: string) => ev.log.some((l) => l.action === action);
  const after = (statuses: readonly string[]) => !statuses.includes(ev.status);
  const started = ev.status === 'live' || ev.status === 'finished';
  const draft = ev.fields.entryKind === 'draft';
  const raw: (Omit<DeskStep, 'state'> & { done: boolean })[] = (draft
    ? [
      { key: 'publish', label: 'Publish', where: 'Above', anchor: 'evdesk-head', done: after(['draft']) },
      { key: 'open', label: 'Open signups', where: 'Above', anchor: 'evdesk-head', done: after(['draft', 'announced']) },
      { key: 'close', label: 'Close signups', where: 'Draft', anchor: 'evdesk-draft', done: logged('draft_signups_closed') || ev.cutAt !== null || started },
      { key: 'captains', label: 'Pick captains', where: 'Draft', anchor: 'evdesk-draft', done: logged('draft_captains_picked') || ev.cutAt !== null || started },
      { key: 'cut', label: 'Publish cut', where: 'Draft', anchor: 'evdesk-draft', done: ev.cutAt !== null || started },
      { key: 'teams', label: 'Make and publish teams', where: 'Make teams', anchor: 'evdesk-teams', done: ev.teamsMadeAt !== null || started },
      { key: 'start', label: 'Start', where: 'Play', anchor: 'evdesk-play', done: started },
      { key: 'finish', label: 'Finish', where: 'Play', anchor: 'evdesk-play', done: ev.status === 'finished' },
    ]
    : [
      { key: 'publish', label: 'Publish', where: 'Above', anchor: 'evdesk-head', done: after(['draft']) },
      { key: 'open', label: 'Open registration', where: 'Above', anchor: 'evdesk-head', done: after(['draft', 'announced']) },
      { key: 'lock', label: 'Close the entry list', where: 'Entries', anchor: 'evdesk-entries', done: logged('entries_locked') || started },
      { key: 'start', label: 'Start', where: 'Play', anchor: 'evdesk-play', done: started },
      { key: 'finish', label: 'Finish', where: 'Play', anchor: 'evdesk-play', done: ev.status === 'finished' },
    ]);
  const cancelled = ev.status === 'cancelled';
  let nowGiven = cancelled;
  return raw.map(({ done, ...s }) => {
    if (done) return { ...s, state: 'done' as const };
    if (!nowGiven) { nowGiven = true; return { ...s, state: 'now' as const }; }
    return { ...s, state: 'later' as const };
  });
}
