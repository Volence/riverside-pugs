import type { JSX } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { api } from '../api';
import { Panel } from '../components/bits';
import { WIDGET_KINDS, type WidgetKind, type WidgetLive, type WidgetPayload } from '../../../src/widgetTypes';
import { DEFAULT_STYLE, STYLES_FOR, SUGGESTED_PX, widgetUrl, type WidgetParams, type WidgetSize, type WidgetStyle } from '../widget/params';
import { WIDGET_POLL_MS } from '../widget/useWidgetData';
import { Widget } from '../widget/Widgets';

/**
 * "Stream widgets" on a player's own profile: pick a widget, a style and a
 * size, see it over a stand-in game with the player's real numbers, and copy
 * the OBS browser source link (/widget/<steamid>/<kind>, web/src/widget).
 * Presets only, as the widget page draws them. Closed until the player asks:
 * most players do not stream.
 */

const KIND_LABEL: Record<WidgetKind, string> = {
  live: 'Live match', rating: 'Rating', session: 'This stream', last: 'Last match', queue: 'Queue',
};
const STYLE_LABEL: Record<WidgetStyle, string> = { bar: 'Bar', card: 'Card', corner: 'Corner', board: 'Scoreboard' };
const SIZES: [WidgetSize, string, string][] = [['s', 'S', 'Small'], ['m', 'M', 'Medium'], ['l', 'L', 'Large']];
const IDLE: [WidgetParams['idle'], string][] = [['hide', 'Hide'], ['note', 'Show a note']];
/** The kinds that have an idle state (not in a match, not queueing). */
const HAS_IDLE: readonly WidgetKind[] = ['live', 'queue'];

const COPIED_MS = 2000;
/** Open or closed is remembered in this browser, so a streamer finds it open. */
const OPEN_KEY = 'stream-widgets-open';

/** Stands in for a match while the player is not in one: No Mercy, map 3
 *  at half-time, the player's team trailing. */
function sampleLive(name: string): WidgetLive {
  return {
    matchId: 0, campaign: 'no_mercy', currentMap: 'l4d_vs_hospital03_sewers',
    mapsPlayed: 2, mapsTotal: 5,
    mine: { side: 'b', names: [name], score: 1070, mine: true },
    theirs: { side: 'a', names: ['Opponents'], score: 1560, mine: false },
    maps: [
      { ordinal: 0, map: 'l4d_vs_hospital01_apartment', mine: 480, theirs: 512 },
      { ordinal: 1, map: 'l4d_vs_hospital02_subway', mine: 590, theirs: 610 },
    ],
    halfTime: { ordinal: 2, mineSurvived: false, score: 438 },
    final: false,
  };
}
const SAMPLE_QUEUE = { count: 6, size: 8, inQueue: true };

const EMPTY_NOTE: Partial<Record<WidgetKind, string>> = {
  rating: 'Your rating shows here after your first PUG this season.',
  last: 'Your last match shows here after your first PUG this season.',
};

/** The preview's data, refreshed every WIDGET_POLL_MS. A failed poll keeps
 *  what is on screen. Not useWidgetData: that hook is the OBS page's. */
function usePreviewData(steamid: string, since: number) {
  const [state, setState] = useState<{ data: WidgetPayload | null; failed: boolean }>({ data: null, failed: false });
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    setState({ data: null, failed: false });
    const poll = async () => {
      try {
        const data = await api.widget(steamid, since);
        if (!stopped) setState({ data, failed: false });
      } catch {
        if (!stopped) setState((s) => ({ ...s, failed: true }));
      }
      if (!stopped) timer = setTimeout(() => void poll(), WIDGET_POLL_MS);
    };
    void poll();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [steamid, since]);
  return state;
}

/**
 * Shrinks the panel to fit the preview's width. The widget is drawn at its
 * real size for a 1080p scene, so a bar (about 1000 px wide) is wider than
 * the profile column. Everything in a panel is in em off one base, so a
 * factor on that base (--wfit, widget.css .w-game .w-root) scales it
 * exactly. Width only: the preview's height follows the panel.
 */
function useFit(deps: unknown[]) {
  const box = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(1);
  const fitRef = useRef(1);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const panel = el.querySelector<HTMLElement>('.w-panel');
      const game = el.querySelector<HTMLElement>('.w-game');
      if (!panel || !game || !panel.offsetWidth || !game.clientWidth) return;
      // The panel's width at full scale; it is linear in --wfit.
      const w = panel.offsetWidth / fitRef.current;
      const room = 0.92;
      const next = Math.min(1, (game.clientWidth * room) / w);
      if (Math.abs(next - fitRef.current) > 0.01) { fitRef.current = next; setFit(next); }
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, deps);
  return { box, fit };
}

function Choice<T extends string>(
  { label, options, value, onPick }: { label: string; options: [T, string, string?][]; value: T; onPick: (v: T) => void },
) {
  return (
    <div class="swidgets__pick">
      <span class="field__label" aria-hidden="true">{label}</span>
      <div class="swidgets__chips" role="group" aria-label={label}>
        {options.map(([v, text, title]) => (
          <button
            key={v} type="button" class={`chip${value === v ? ' is-on' : ''}`}
            aria-pressed={value === v} title={title} onClick={() => onPick(v)}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

export function StreamWidgets({ steamid }: { steamid: string }): JSX.Element {
  const [open, setOpenState] = useState(() => {
    try { return localStorage.getItem(OPEN_KEY) === '1'; } catch { return false; }
  });
  const setOpen = (next: boolean) => {
    setOpenState(next);
    try {
      if (next) localStorage.setItem(OPEN_KEY, '1');
      else localStorage.removeItem(OPEN_KEY);
    } catch { /* no storage: closed on the next visit */ }
  };

  return (
    <Panel class="swidgets">
      <h3>Stream widgets</h3>
      <p class="muted">Show your Riverside numbers on stream. In OBS: Sources, +, Browser, then paste the link.</p>
      {open ? (
        <>
          <Setup steamid={steamid} />
          <div><button type="button" class="btn btn--ghost btn--sm" onClick={() => setOpen(false)}>Hide setup</button></div>
        </>
      ) : (
        <div><button type="button" class="btn btn--ghost btn--sm" onClick={() => setOpen(true)}>Set up a widget</button></div>
      )}
    </Panel>
  );
}

/** The pickers, preview and link: mounted only while open, so a closed
 *  section never polls. */
function Setup({ steamid }: { steamid: string }): JSX.Element {
  const [kind, setKind] = useState<WidgetKind>('live');
  // The style the player picked, if any. Each kind uses it when it has it,
  // and its own default otherwise.
  const [picked, setStyle] = useState<WidgetStyle | null>(null);
  const [size, setSize] = useState<WidgetSize>('m');
  const [idle, setIdle] = useState<WidgetParams['idle']>('hide');
  const [copied, setCopied] = useState(false);
  // "This stream" in the preview counts from when this page opened, as the
  // widget counts from when OBS loads it.
  const [since] = useState(() => Date.now());
  const { data, failed } = usePreviewData(steamid, since);
  const input = useRef<HTMLInputElement>(null);

  const style = picked && STYLES_FOR[kind].includes(picked) ? picked : DEFAULT_STYLE[kind];
  const params: WidgetParams = { steamid, kind, style, size, idle };
  const url = widgetUrl(location.origin, params);
  const [w, h] = SUGGESTED_PX[style][size];

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // No clipboard access: select it for a manual copy.
      input.current?.select();
    }
  };

  // While not in a match (or not queueing) the preview shows a sample, so
  // the style can still be judged.
  let sample: string | null = null;
  let shown = data;
  if (data && kind === 'live' && !data.live) {
    shown = { ...data, live: sampleLive(data.player.name) };
    sample = "Sample: shows your match when you're in one";
  } else if (data && kind === 'queue' && !data.queue?.inQueue) {
    shown = { ...data, queue: SAMPLE_QUEUE };
    sample = "Sample: shows the queue while you're in it";
  }
  const empty = shown !== null && (
    (kind === 'rating' && !shown.rating) || (kind === 'session' && !shown.session) || (kind === 'last' && !shown.last)
  );
  const { box, fit } = useFit([kind, style, size, idle, data]);

  return (
    <>
      <div class="swidgets__picks">
        <Choice label="Widget" options={WIDGET_KINDS.map((k) => [k, KIND_LABEL[k]])} value={kind} onPick={setKind} />
        <Choice label="Style" options={STYLES_FOR[kind].map((s) => [s, STYLE_LABEL[s]])} value={style} onPick={setStyle} />
        <Choice label="Size" options={SIZES} value={size} onPick={setSize} />
        {HAS_IDLE.includes(kind) && <Choice label="If idle" options={IDLE} value={idle} onPick={setIdle} />}
      </div>

      <div class="swidgets__preview" ref={box} style={{ '--wfit': String(fit) } as JSX.CSSProperties} role="group" aria-label="Preview">
        {shown === null ? (
          <div class="w-game"><p class="swidgets__msg muted">{failed ? 'Could not load the preview.' : 'Loading preview'}</p></div>
        ) : empty ? (
          <div class="w-game"><p class="swidgets__msg muted">{EMPTY_NOTE[kind] ?? 'Nothing to show yet.'}</p></div>
        ) : (
          <Widget params={params} data={shown} preview />
        )}
      </div>
      {(sample || fit < 0.99) && (
        <p class="muted swidgets__under">
          {sample && <span>{sample}</span>}
          {fit < 0.99 && <span>{`Shown at ${Math.round(fit * 100)}% to fit this page.`}</span>}
        </p>
      )}

      <div class="swidgets__link">
        <input ref={input} class="field__input" type="text" readOnly value={url} aria-label="Widget link" onFocus={(e) => (e.target as HTMLInputElement).select()} />
        <button type="button" class="btn btn--ghost btn--sm" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
      <p class="swidgets__size">{`Suggested size in OBS: ${w} x ${h}`}</p>
      <p class="muted swidgets__help">OBS's "Refresh browser when scene becomes active" is optional; the widget updates itself.</p>
      {kind === 'session' && (
        <p class="muted swidgets__help">
          This stream counts from when OBS loads the widget. To start a new count, load the link once with <code>?reset=1</code> on the end
          (<code>&amp;reset=1</code> if it already has a <code>?</code>), then remove it: while it is in the link, every load starts the count again.
        </p>
      )}
    </>
  );
}
