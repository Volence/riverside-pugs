import { useEffect, useId, useRef, useState } from 'preact/hooks';
import { adminApi, type AdminGameConfig } from '../../../api';
import { useFetch } from '../../../hooks/useFetch';
import { Empty, Panel } from '../../../components/bits';
import { useAction, type Run } from '../useAction';
import { FormRow } from '../events/FormRow';
import { inUseText } from './AdminRulesets';

/** One config: its label (editable), the cfg setup execs, on or off, and
 *  Delete while nothing open uses it. 'standard' is never off or deleted. */
function ConfigRow({ c, busy, run }: { c: AdminGameConfig; busy: boolean; run: Run }) {
  const [label, setLabel] = useState(c.label);
  const unused = c.inUse.bookings === 0 && c.inUse.events === 0;
  const uid = useId();
  return (
    <li>
      <strong>{c.label}</strong>{' '}
      <span class="teamchip">{c.key}</span>{' '}
      {c.locked && <><span class="teamchip">Default</span>{' '}</>}
      {!c.enabled && <><span class="teamchip teamchip--cancelled">Off</span>{' '}</>}
      <span class="muted">· exec {c.cfg} · {inUseText(c.inUse)}</span>
      <FormRow label="Label" help="What the pickers show." for={`${uid}-label`}>
        <input id={`${uid}-label`} aria-label={`Label for ${c.key}`} value={label} maxLength={60} onInput={(e) => setLabel((e.target as HTMLInputElement).value)} />
        <button class="btn btn--ghost btn--sm" type="button" disabled={busy || label.trim() === c.label}
          onClick={() => void run(() => adminApi.updateGameConfig(c.key, { label, enabled: c.enabled }))}>Save label</button>
        {!c.locked && (
          <button class="btn btn--ghost btn--sm" type="button" disabled={busy}
            onClick={() => void run(() => adminApi.updateGameConfig(c.key, { label: c.label, enabled: !c.enabled }))}>
            {c.enabled ? 'Turn off' : 'Turn on'}
          </button>
        )}
        {!c.locked && unused && (
          <button class="btn btn--ghost btn--sm" type="button" disabled={busy}
            onClick={() => void run(() => adminApi.deleteGameConfig(c.key), {
              title: `Delete ${c.label}?`, body: 'Finished bookings and events that used it keep showing its key.', confirmLabel: 'Delete', danger: true,
            })}>Delete</button>
        )}
      </FormRow>
    </li>
  );
}

/** Setup > Game configs (admins only): the balance layers bookings and event
 *  stages may pick. Turning one off takes it out of the pickers only. */
export function AdminGameConfigs() {
  const { data, reload } = useFetch((s) => adminApi.gameConfigs(s), []);
  const { busy, error, run } = useAction(reload);
  const [key, setKey] = useState('');
  const [label, setLabel] = useState('');
  const [cfg, setCfg] = useState('');
  const uid = useId();
  const errorRef = useRef<HTMLParagraphElement>(null);
  // A row's own Save sits wherever that row is in a possibly long list, so a
  // refusal from it can land off screen above; bring it into view instead of
  // leaving the admin to go hunting for why nothing happened.
  useEffect(() => { if (error) errorRef.current?.scrollIntoView({ block: 'center' }); }, [error]);
  if (!data) return <Panel><p class="muted">Loading...</p></Panel>;

  const create = (e: Event) => {
    e.preventDefault();
    void run(async () => {
      await adminApi.createGameConfig({ key: key.trim(), label, cfg: cfg.trim() });
      setKey(''); setLabel(''); setCfg('');
    });
  };

  return (
    <div class="stack">
      {error && <p class="error" role="alert" ref={errorRef}>{error}</p>}
      <Panel>
        <h3>Game configs</h3>
        <p class="muted">What a booked or tournament server runs. Off takes a config out of the pickers; what already uses it keeps it.</p>
        {data.gameConfigs.length === 0 ? <Empty>No game configs.</Empty> : (
          <ul class="admin-list rulesetlist">
            {data.gameConfigs.map((c) => <ConfigRow key={`${c.key}:${c.label}`} c={c} busy={busy} run={run} />)}
          </ul>
        )}
      </Panel>
      <Panel>
        <h3>New game config</h3>
        <p class="admin-warn">The cfg file must already be on every pool server. Setup runs <code>exec {cfg.trim() || '<cfg>'}</code> on whichever box the booking gets.</p>
        <form class="eventform" onSubmit={create}>
          <FormRow label="Key" help="2 to 32 lowercase letters, digits or underscores. Fixed once made." for={`${uid}-key`}>
            <input id={`${uid}-key`} aria-label="Key" value={key} maxLength={32} onInput={(e) => setKey((e.target as HTMLInputElement).value)} />
          </FormRow>
          <FormRow label="Label" help="What the pickers show. 3 to 60 characters." for={`${uid}-label`}>
            <input id={`${uid}-label`} aria-label="Label" value={label} maxLength={60} onInput={(e) => setLabel((e.target as HTMLInputElement).value)} />
          </FormRow>
          <FormRow label="Cfg" help="The file name without .cfg: lowercase letters, digits and underscores." for={`${uid}-cfg`}>
            <input id={`${uid}-cfg`} aria-label="Cfg" value={cfg} maxLength={64} onInput={(e) => setCfg((e.target as HTMLInputElement).value)} />
          </FormRow>
          <div class="eventform__actions">
            <button class="btn" type="submit" disabled={busy || !key.trim() || !label.trim() || !cfg.trim()}>Add config</button>
          </div>
        </form>
      </Panel>
    </div>
  );
}
