import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Panel } from '../components/bits';
import { HudTabs } from '../components/HudTabs';
import { Field } from '../crosshair/Builder';
import { saveBytes } from '../crosshair/download';
import {
  DEFAULT_STATE, GLOWS, RIVERSIDE_GLOWS, buildCfg, fromHex, gameDefaults, parseCfg, readState,
  sameColour, toHex, type AutoexecState, type ColorblindChoice, type GlowCvar, type Rgb,
} from '../autoexec/glows';
import { MASK_SIZE, SCENES, paintScene, slotAnchor, type Scene } from '../autoexec/preview';

const STORAGE_KEY = 'autoexec-builder';

function loadState(): AutoexecState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? readState(JSON.parse(raw)) : DEFAULT_STATE;
  } catch {
    return DEFAULT_STATE;
  }
}

function saveState(s: AutoexecState) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* storage off: the page still works */ }
}

const HAS_CB = new Set(GLOWS.filter((g) => g.colorblind).map((g) => g.id.replace(/_colorblind$/, '')));

/** The cvar a row edits: its colour-blind variant while that set is being edited. */
const rowId = (id: string, cb: boolean) => (cb && HAS_CB.has(id) ? `${id}_colorblind` : id);

/** Which preview outline shows a glow, and what that outline is called while it does. */
const SHOWN_ON: Record<string, { scene: Scene['id']; slot: string; label: string }> = {
  survivor: { scene: 'survivor', slot: 'teammate', label: 'Teammate' },
  survivor_hurt: { scene: 'survivor', slot: 'incap', label: 'Incapped' },
  survivor_vomit: { scene: 'survivor', slot: 'boomed', label: 'Boomed' },
  infected: { scene: 'infected', slot: 'teammate', label: 'Infected teammate' },
  ghost_infected: { scene: 'infected', slot: 'teammate', label: 'Ghost teammate' },
  survivor_health_high: { scene: 'infected', slot: 'high', label: 'High health' },
  survivor_health_med: { scene: 'infected', slot: 'med', label: 'Medium health' },
  survivor_health_low: { scene: 'infected', slot: 'low', label: 'Low health' },
  infected_vomit: { scene: 'infected', slot: 'med', label: 'Boomed' },
  ability: { scene: 'infected', slot: 'low', label: 'Ability' },
};

/** The glow each outline shows when nothing that shares it is picked. */
const SLOT_DEFAULT: Record<string, string> = {
  'survivor/teammate': 'survivor', 'survivor/incap': 'survivor_hurt', 'survivor/boomed': 'survivor_vomit',
  'infected/teammate': 'infected', 'infected/high': 'survivor_health_high',
  'infected/med': 'survivor_health_med', 'infected/low': 'survivor_health_low',
};

const PLAIN = GLOWS.filter((g) => !g.colorblind);

export function Autoexec() {
  const [state, setState] = useState<AutoexecState>(loadState);
  const [cb, setCb] = useState(() => loadState().colorblind === '2');
  const [focus, setFocus] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [paste, setPaste] = useState('');

  const set = (next: AutoexecState) => { setState(next); saveState(next); };
  const setGlow = (id: string, c: Rgb) => set({ ...state, glows: { ...state.glows, [id]: c } });

  // For each outline, the glow it shows: the picked row when it lives there, else the outline's own.
  const slotGlow = useMemo(() => {
    const out: Record<string, string> = { ...SLOT_DEFAULT };
    const at = focus ? SHOWN_ON[focus] : undefined;
    if (at) out[`${at.scene}/${at.slot}`] = focus!;
    return out;
  }, [focus]);

  const colourOf = (id: string) => state.glows[rowId(id, cb)];

  const cfg = useMemo(() => buildCfg(state), [state]);

  const loadText = (text: string, from: string) => {
    const r = parseCfg(text, state);
    if (r.read === 0) {
      setStatus(`No glow colours found in ${from}.`);
      return;
    }
    set(r.state);
    if (r.state.colorblind === '2') setCb(true);
    setStatus(`Read ${r.read} setting${r.read === 1 ? '' : 's'} from ${from}.`
      + (r.ignored.length ? ` Skipped ${r.ignored.join(', ')}: a normal game client ignores ${r.ignored.length === 1 ? 'it' : 'them'}.` : ''));
  };

  const pickFile = (e: Event) => {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0];
    input.value = '';
    if (!f) return;
    f.text().then((t) => loadText(t, f.name), () => setStatus(`Could not read ${f.name}.`));
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(cfg);
      setStatus('Copied. Paste it at the end of your autoexec.cfg.');
    } catch {
      setStatus('Your browser blocked copying: select the text below and copy it by hand.');
    }
  };

  const download = () => {
    saveBytes('glows.cfg', new TextEncoder().encode(cfg) as Uint8Array<ArrayBuffer>, 'text/plain');
    setStatus('Saved glows.cfg. Put it in left4dead/cfg/ and add the line exec glows to your autoexec.cfg.');
  };

  return (
    <div class="page page--wide">
      <HudTabs active="autoexec" />
      <h2 class="sr-only">Autoexec builder</h2>

      <div class="ax">
        <Panel class="ax__controls">
          <p class="muted ax__intro">
            Pick your glow colours and see them on real in-game shots. Only settings a normal game client accepts are
            here, and only values it accepts. The game forgets these every time it closes, so they go in your autoexec.
          </p>

          <Field legend="Start from">
            <div class="xh__presets">
              <button type="button" class="chip" onClick={() => set({ ...state, glows: gameDefaults() })}>Game default</button>
              <button type="button" class="chip" onClick={() => set({ ...state, glows: { ...gameDefaults(), ...RIVERSIDE_GLOWS } })}>Riverside autoexec</button>
            </div>
            <label class="xh__file">
              <span>Load the glows from your own autoexec.cfg</span>
              <input type="file" accept=".cfg,.txt,text/plain" onChange={pickFile} />
            </label>
            <details class="ax__paste">
              <summary>Or paste lines</summary>
              <textarea rows={4} value={paste} placeholder='cl_glow_survivor_r "0"'
                onInput={(e) => setPaste((e.target as HTMLTextAreaElement).value)} />
              <button type="button" class="btn btn--ghost" onClick={() => loadText(paste, 'the pasted lines')}>Read pasted lines</button>
            </details>
          </Field>

          <Field legend="Colour-blind mode">
            <label class="xh__row ax__cbrow">
              <span>cl_colorblind</span>
              <select value={state.colorblind}
                onChange={(e) => {
                  const v = (e.target as HTMLSelectElement).value as ColorblindChoice;
                  set({ ...state, colorblind: v });
                  if (v === '2') setCb(true);
                  else if (v === '0' || v === '1') setCb(false);
                }}>
                <option value="keep">Leave mine as it is</option>
                <option value="0">0: off</option>
                <option value="1">1: high-contrast crosshair</option>
                <option value="2">2: colour-blind colours</option>
              </select>
              <span />
            </label>
            <label class="xh__check">
              <input type="checkbox" checked={cb} onChange={(e) => setCb((e.target as HTMLInputElement).checked)} />
              Edit and preview the colour-blind set (used with cl_colorblind 2)
            </label>
          </Field>

          {(['survivor', 'infected'] as const).map((side) => (
            <Field key={side} legend={side === 'survivor' ? 'Seen as a survivor' : 'Seen as infected'}>
              {PLAIN.filter((g) => g.side === side).map((g) => (
                <GlowRow
                  key={g.id} glow={g} cvar={rowId(g.id, cb)} colour={colourOf(g.id)}
                  def={GLOWS.find((x) => x.id === rowId(g.id, cb))!.def}
                  active={focus === g.id}
                  onFocus={() => setFocus(g.id)}
                  onChange={(c) => setGlow(rowId(g.id, cb), c)}
                />
              ))}
            </Field>
          ))}

          <Field legend="Save">
            <button type="button" class="btn btn--block" onClick={download}>Download glows.cfg</button>
            <button type="button" class="btn btn--ghost btn--block ax__copy" onClick={copy}>Copy the lines</button>
            {status && <p class="muted xh__status" role="status">{status}</p>}
            <p class="muted xh__status">
              glows.cfg goes in <code>steamapps/common/left 4 dead/left4dead/cfg/</code>. Add <code>exec glows</code> on
              its own line at the end of your <code>autoexec.cfg</code> there (our <a href="/autoexec.cfg" download="autoexec.cfg">autoexec.cfg</a> sets
              glows too, so the exec line goes below them).
            </p>
            <details class="ax__cfg">
              <summary>Show the file</summary>
              <pre>{cfg}</pre>
            </details>
          </Field>
        </Panel>

        <div class="ax__previews">
          {SCENES.map((scene) => (
            <ScenePreview
              key={scene.id} scene={scene} focus={focus}
              colours={Object.fromEntries(scene.slots.map((s) => [s.key, colourOf(slotGlow[`${scene.id}/${s.key}`])]))}
              labels={Object.fromEntries(scene.slots.map((s) => {
                const id = slotGlow[`${scene.id}/${s.key}`];
                return [s.key, SHOWN_ON[id].label];
              }))}
              picked={Object.fromEntries(scene.slots.map((s) => [s.key, slotGlow[`${scene.id}/${s.key}`] === focus]))}
            />
          ))}
          <p class="muted ax__note">
            Shots from the game at 1920 x 1080 with the outlines it draws through walls; the colours are laid on the
            way the game adds them. Pick a row to see it here. Items have no picture yet: their outline is the same
            kind, around the item.
          </p>
        </div>
      </div>
    </div>
  );
}

function GlowRow({ glow, cvar, colour, def, active, onFocus, onChange }: {
  glow: GlowCvar; cvar: string; colour: Rgb; def: Rgb; active: boolean;
  onFocus: () => void; onChange: (c: Rgb) => void;
}) {
  const hex = toHex(colour);
  const [text, setText] = useState(hex);
  useEffect(() => setText(hex), [hex]);
  const isDefault = sameColour(colour, def);
  return (
    <div class={`ax__row${active ? ' is-active' : ''}`} onFocusIn={onFocus} onClick={onFocus}>
      <div class="ax__name">
        <span>{glow.label}</span>
        <small class="muted" title={`cl_glow_${cvar}_r/_g/_b`}>{glow.hint}</small>
      </div>
      <input type="color" value={hex} aria-label={`${glow.label} colour`}
        onInput={(e) => { const c = fromHex((e.target as HTMLInputElement).value); if (c) onChange(c); }} />
      <input type="text" class="ax__hex" value={text} spellcheck={false} maxLength={7} aria-label={`${glow.label} hex code`}
        onInput={(e) => {
          const v = (e.target as HTMLInputElement).value;
          setText(v);
          const c = fromHex(v);
          if (c && v.replace('#', '').length === 6) onChange(c);
        }}
        onBlur={() => setText(hex)} />
      <button type="button" class="ax__reset" disabled={isDefault} title="Back to the game's default"
        onClick={() => onChange(def)}>Reset</button>
    </div>
  );
}

function ScenePreview({ scene, colours, labels, picked, focus }: {
  scene: Scene; colours: Record<string, Rgb>; labels: Record<string, string>;
  picked: Record<string, boolean>; focus: string | null;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const key = JSON.stringify(colours);
  useEffect(() => {
    if (canvas.current) paintScene(canvas.current, scene, colours).catch(() => {});
  }, [key]);
  return (
    <figure class="ax__scene">
      <figcaption class="eyebrow">{scene.title}</figcaption>
      <div class="ax__frame">
        <canvas ref={canvas} class="ax__canvas" role="img"
          aria-label={`${scene.title}: ${scene.slots.map((s) => `${labels[s.key]} ${toHex(colours[s.key])}`).join(', ')}`} />
        {scene.slots.map((s) => {
          const at = slotAnchor(s, MASK_SIZE);
          return (
            <span key={s.key} class={`ax__tag${picked[s.key] && focus ? ' is-picked' : ''}`}
              style={{ left: `${at.left}%`, top: `${at.top}%` }}>
              {labels[s.key]}
            </span>
          );
        })}
      </div>
    </figure>
  );
}

export default Autoexec;
