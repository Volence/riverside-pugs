import { useEffect, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { adminApi, adminBannerUrl, ApiError, type AdminEventDetail } from '../../../api';
import { useFetch } from '../../../hooks/useFetch';
import { Empty, Panel } from '../../../components/bits';
import { RichText } from '../../../components/RichText';
import { STATUS_LABEL, whenText } from '../../../eventFormat';
import { toBannerImage } from '../../../eventBanner';
import { fmtTime, useAction } from '../useAction';
import { EventFieldsForm } from './EventFieldsForm';
import { StageForm } from './StageForm';
import { EntriesPanel } from './EntriesPanel';
import { PlayPanel } from './PlayPanel';
import { DESKS } from '../adminRoutes';

const DESK_URL = DESKS.find((d) => d.key === 'events')!.path;

/** Mirrors V.EVENT_EDITABLE and V.STAGES_LOCKED (src/events/validate.ts). */
const EDITABLE: readonly string[] = ['draft', 'announced', 'registration'];
const STAGES_LOCKED: readonly string[] = ['live', 'finished', 'cancelled'];
const ACTION_TEXT: Record<string, string> = {
  created: 'Created', edited: 'Edited', stage_added: 'Stage added', stage_edited: 'Stage edited', stage_removed: 'Stage removed',
  stages_reordered: 'Stages reordered', published: 'Published', registration_opened: 'Registration opened', cancelled: 'Cancelled',
  banner_set: 'Banner set', banner_removed: 'Banner removed',
  checkin_opened: 'Check-in opened', entry_registered: 'Team registered', roster_changed: 'Roster changed', roster_left: 'Player left a roster',
  entry_withdrawn: 'Team withdrew', entry_checked_in: 'Team checked in', entries_locked: 'Entry list closed', entry_dropped: 'Entry dropped',
  entry_disqualified: 'Entry disqualified', entry_restored: 'Entry restored', seeds_reordered: 'Seeds reordered',
};

/** What a mod reads in place of the form (Ruling 2). */
function Details({ ev }: { ev: AdminEventDetail }) {
  const f = ev.fields;
  return (
    <ul class="admin-list">
      <li>Starts {whenText(f.startsAt)}</li>
      <li>{f.entryKind === 'team' ? 'Teams register' : 'Draft (individual signups)'}{f.official ? ', official' : ''}{f.teamCap !== null ? `, up to ${f.teamCap} teams` : ''}</li>
      <li>At least {f.eligibility.minPugs} completed PUGs{f.eligibility.requireDiscord ? ', Discord linked' : ''}</li>
      <li>{f.checkin.enabled ? `Check-in ${f.checkin.opensMinutes} to ${f.checkin.closesMinutes} minutes before the start` : 'No check-in'}</li>
      {f.description && <li><RichText text={f.description} /></li>}
    </ul>
  );
}

/** One event on the Events desk: lifecycle, fields, banner, stages, history.
 *  canEdit false (a mod) shows the same event with no control at all; the
 *  server refuses every write from a mod regardless. */
export function EventEditor({ id, canEdit }: { id: number; canEdit: boolean }) {
  const { data: ev, error: loadError, reload } = useFetch((s) => adminApi.event(id, s), [id]);
  const { data: options } = useFetch((s) => adminApi.eventOptions(s), []);
  const { busy, error, run } = useAction(reload);
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [reason, setReason] = useState('');
  const { route } = useLocation();
  /** The fields form is keyed by the event id plus this, and it moves only
   *  once the event has reloaded after the form's own successful save, so
   *  the form then shows what the server stored. Any other reload (a banner,
   *  a stage) leaves unsaved typing alone. */
  const [formGen, setFormGen] = useState(0);
  /** Moves when the Entries or Play panel starts the event, closes the list
   *  or opens check-in: the editor reloads (header, stages, history) and both
   *  panels fetch again, so neither shows the step before. */
  const [panelGen, setPanelGen] = useState(0);
  const panelsChanged = () => { reload(); setPanelGen((g) => g + 1); };
  const [resetForm, setResetForm] = useState(false);
  useEffect(() => {
    if (!resetForm) return;
    setResetForm(false);
    setFormGen((g) => g + 1);
  }, [ev]);

  if (loadError instanceof ApiError && loadError.status === 404) return <Panel><Empty>No such event.</Empty></Panel>;
  if (!ev || !options) return <Panel><p class="muted">Loading...</p></Panel>;

  const stagesOpen = canEdit && !STAGES_LOCKED.includes(ev.status);
  const over = ev.status === 'finished' || ev.status === 'cancelled';
  const move = (i: number, by: -1 | 1) => {
    const ids = ev.stages.map((s) => s.id);
    [ids[i], ids[i + by]] = [ids[i + by], ids[i]];
    void run(() => adminApi.reorderStages(id, ids));
  };
  /** Closes the stage form only once the server took the stage. */
  const saveStage = (call: () => Promise<unknown>) => {
    void run(async () => { await call(); setEditing(null); });
  };
  const saveFields = (f: AdminEventDetail['fields']) => {
    void run(async () => { await adminApi.updateEvent(id, f); setResetForm(true); });
  };

  return (
    <div class="stack">
      <Panel>
        <h3>{ev.fields.name} <span class={`teamchip eventstatus eventstatus--${ev.status}`}>{STATUS_LABEL[ev.status]}</span></h3>
        <p class="muted"><a href={`/event/${ev.slug}`}>/event/{ev.slug}</a> · last change {fmtTime(ev.updatedAt)}</p>
        {ev.cancelReason && <p class="muted">Cancelled: {ev.cancelReason}</p>}
        {!canEdit && <p class="muted">Read only: admins run events.</p>}
        {error && <p class="error" role="alert">{error}</p>}
        {canEdit && (
          <div class="admin-row">
            {ev.status === 'draft' && (
              <button class="btn" disabled={busy}
                onClick={() => void run(() => adminApi.publishEvent(id), 'Publish this event? Everyone the competitive switch lets in will see it on /events.')}>
                Publish
              </button>
            )}
            {ev.status === 'announced' && ev.fields.entryKind === 'team' && (
              <button class="btn" disabled={busy} onClick={() => void run(() => adminApi.openEventRegistration(id), 'Open registration?')}>
                Open registration
              </button>
            )}
            {ev.status === 'draft' && (
              <button class="btn btn--danger" disabled={busy} onClick={() => void run(async () => {
                await adminApi.deleteEvent(id);
                route(DESK_URL);
              }, 'Delete this draft? Its stages and history go with it. Nobody outside staff has seen it.')}>
                Delete draft
              </button>
            )}
          </div>
        )}
        {canEdit && !over && ev.status !== 'draft' && (
          <form class="admin-form" onSubmit={(e) => { e.preventDefault(); void run(() => adminApi.cancelEvent(id, reason), 'Cancel this event? It cannot be reopened.'); }}>
            <input aria-label="Cancel reason" placeholder="Reason, shown on the event page" maxLength={300} value={reason}
              onInput={(e) => setReason((e.target as HTMLInputElement).value)} />
            <button class="btn btn--danger" type="submit" disabled={busy}>Cancel event</button>
          </form>
        )}
      </Panel>
      <Panel>
        <h3>Event</h3>
        {canEdit && EDITABLE.includes(ev.status)
          ? <EventFieldsForm key={`${ev.id}:${formGen}`} fields={ev.fields} status={ev.status} busy={busy} onSave={saveFields} />
          : <Details ev={ev} />}
      </Panel>
      <Panel>
        <h3>Banner</h3>
        {ev.bannerKey ? <img class="eventbanner" src={adminBannerUrl(ev.id, ev.bannerKey)} alt="" width={1600} height={400} /> : <Empty>No banner.</Empty>}
        {canEdit && (
          <div class="inlinerow">
            <label class="btn btn--ghost btn--sm">
              {ev.bannerKey ? 'Replace banner' : 'Upload banner'}
              <input class="sr-only" type="file" accept="image/png,image/jpeg,image/webp" aria-label="Banner" disabled={busy} onChange={(e) => {
                const f = (e.target as HTMLInputElement).files?.[0];
                if (f) void run(async () => adminApi.setEventBanner(id, await toBannerImage(f)));
              }} />
            </label>
            {ev.bannerKey && (
              <button class="btn btn--ghost btn--sm" disabled={busy} onClick={() => void run(() => adminApi.removeEventBanner(id), 'Remove the banner?')}>
                Remove banner
              </button>
            )}
            <span class="muted">Cropped to 4:1 and scaled to 1600 x 400.</span>
          </div>
        )}
      </Panel>
      <Panel>
        <h3>Stages</h3>
        {ev.stages.length === 0 ? <Empty>No stages yet. An event needs at least one before it can be published.</Empty> : (
          <ol class="admin-list eventstages">
            {ev.stages.map((s, i) => (
              <li key={s.id}>
                <div class="eventstage__head">
                  <span><strong>Stage {s.ordinal}</strong> <span>{s.summary}</span></span>
                  {stagesOpen && (
                    <span class="inlinerow">
                      <button class="btn btn--ghost btn--sm" aria-label={`Move stage ${s.ordinal} up`} disabled={busy || i === 0} onClick={() => move(i, -1)}>Up</button>
                      <button class="btn btn--ghost btn--sm" aria-label={`Move stage ${s.ordinal} down`} disabled={busy || i === ev.stages.length - 1} onClick={() => move(i, 1)}>Down</button>
                      <button class="btn btn--ghost btn--sm" aria-label={`Edit stage ${s.ordinal}`} disabled={editing !== null} onClick={() => setEditing(s.id)}>Edit</button>
                      <button class="btn btn--ghost btn--sm" aria-label={`Remove stage ${s.ordinal}`} disabled={busy}
                        onClick={() => void run(() => adminApi.removeStage(id, s.id), `Remove stage ${s.ordinal}?`)}>Remove</button>
                    </span>
                  )}
                </div>
                {editing === s.id && (
                  <StageForm options={options} initial={s.settings} busy={busy} onCancel={() => setEditing(null)} teamCap={ev.fields.teamCap}
                    onSave={(st) => saveStage(() => adminApi.updateStage(id, s.id, st))} />
                )}
              </li>
            ))}
          </ol>
        )}
        {stagesOpen && editing === null && <button class="btn" onClick={() => setEditing('new')}>Add stage</button>}
        {editing === 'new' && (
          <StageForm options={options} initial={null} busy={busy} onCancel={() => setEditing(null)} teamCap={ev.fields.teamCap}
            onSave={(st) => saveStage(() => adminApi.addStage(id, st))} />
        )}
      </Panel>
      {ev.status !== 'draft' && ev.status !== 'announced' && <EntriesPanel eventId={ev.id} status={ev.status} checkin={ev.fields.checkin.enabled} canEdit={canEdit} gen={panelGen} onChange={panelsChanged} />}
      {['registration', 'checkin', 'live', 'finished'].includes(ev.status) && <PlayPanel eventId={ev.id} canEdit={canEdit} gen={panelGen} onChange={panelsChanged} slug={ev.slug} />}
      <Panel>
        <h3>History</h3>
        <ul class="admin-list">
          {ev.log.map((l, i) => <li key={i}>{fmtTime(l.at)} · {l.actorName ?? 'the clock'} · {ACTION_TEXT[l.action] ?? l.action}</li>)}
        </ul>
      </Panel>
    </div>
  );
}
