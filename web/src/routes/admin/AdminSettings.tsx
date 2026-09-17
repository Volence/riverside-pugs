import { useState } from 'preact/hooks';
import { adminApi, ApiError, type AdminSetting } from '../../api';
import { useFetch } from '../../hooks/useFetch';
import { Panel } from '../../components/bits';

export function AdminSettings() {
  const { data, reload } = useFetch((s) => adminApi.settings(s), []);
  if (!data) return <Panel><p class="muted">Loading...</p></Panel>;
  const groups = [...new Set(data.settings.map((s) => s.group))];
  return (
    <div class="stack">
      {groups.map((g) => (
        <Panel key={g}>
          <h3>{g}</h3>
          <div class="admin-settings">
            {data.settings.filter((s) => s.group === g).map((s) => (
              <SettingRow key={s.key} setting={s} campaigns={data.campaigns} onSaved={reload} />
            ))}
          </div>
        </Panel>
      ))}
    </div>
  );
}

function initial(s: AdminSetting): string {
  if (s.type.kind === 'intList') {
    try { return (JSON.parse(s.value) as number[]).join(', '); } catch { return ''; }
  }
  return s.value;
}

function SettingRow({ setting: s, campaigns, onSaved }: {
  setting: AdminSetting; campaigns: { slug: string; name: string }[]; onSaved: () => void;
}) {
  const [value, setValue] = useState(initial(s));
  const [pool, setPool] = useState<string[]>(() => {
    try { return s.type.kind === 'campaigns' ? JSON.parse(s.value) as string[] : []; } catch { return []; }
  });
  const [revealed, setRevealed] = useState(!s.secret);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const save = async (raw: unknown) => {
    setMsg(null);
    try {
      await adminApi.saveSetting(s.key, raw);
      setMsg({ ok: true, text: 'Saved' });
      onSaved();
    } catch (err) {
      setMsg({ ok: false, text: err instanceof ApiError ? err.message : 'Could not save' });
    }
  };

  const submit = (e: Event) => {
    e.preventDefault();
    if (s.type.kind === 'campaigns') return void save(pool);
    if (s.type.kind === 'intList') {
      return void save(value.split(',').map((x) => x.trim()).filter(Boolean).map(Number));
    }
    return void save(value);
  };

  let input;
  switch (s.type.kind) {
    case 'bool':
      input = (
        <label class="admin-toggle">
          <input type="checkbox" checked={s.value === '1'} onChange={(e) => void save((e.target as HTMLInputElement).checked)} />
          {s.value === '1' ? 'On' : 'Off'}
        </label>
      );
      break;
    case 'campaigns':
      input = (
        <div class="admin-checks">
          {campaigns.map((c) => (
            <label key={c.slug}>
              <input type="checkbox" checked={pool.includes(c.slug)}
                onChange={(e) => setPool((e.target as HTMLInputElement).checked ? [...pool, c.slug] : pool.filter((x) => x !== c.slug))} />
              {c.name}
            </label>
          ))}
        </div>
      );
      break;
    default:
      input = revealed ? (
        <input value={value} aria-label={s.label} inputMode={s.type.kind === 'int' ? 'numeric' : undefined}
          onInput={(e) => setValue((e.target as HTMLInputElement).value)} />
      ) : (
        <button type="button" class="chip" onClick={() => setRevealed(true)}>Show</button>
      );
  }

  return (
    <form class="admin-setting" onSubmit={submit}>
      <div>
        <label class="admin-setting__label">{s.label}</label>
        <p class="muted">{s.help}{s.type.kind === 'int' ? ` (${s.type.min} to ${s.type.max})` : ''}</p>
      </div>
      <div class="admin-setting__control">
        {input}
        {s.type.kind !== 'bool' && revealed && <button class="btn" type="submit">Save</button>}
        {msg && <span class={msg.ok ? 'muted' : 'error'}>{msg.text}</span>}
      </div>
    </form>
  );
}
