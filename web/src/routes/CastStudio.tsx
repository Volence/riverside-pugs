import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ApiError, studioApi, type PrepSheet, type StudioPanel } from '../api';
import { PageHeader } from '../components/PageHeader';
import { Empty } from '../components/bits';
import { campaignTint } from '../format';
import { connectObs, type ObsClient, type ObsStatus } from '../cast/obs';
import {
  LAYERS, MAX_CASTERS, SCENES, SCENE_LABELS, THEMES,
  type CastMatchView, type LiveElements, type OverlayFeed, type SceneKey, type StudioState, type TeamOverride,
} from '../../../src/cast/types';

/**
 * The caster studio's producer panel (docs/superpowers/plans/2026-10-02-caster-studio.md).
 * Pick what is on air, cut between scenes, drive the lower third, countdown,
 * callouts and overrides, and (optionally) the caster's own OBS. Everything
 * is saved to the caster's studio row as it changes, so a reload loses
 * nothing and every overlay follows within a second.
 */

const SAVE_DEBOUNCE_MS = 350;
const FEED_POLL_MS = 1500;
const PANEL_POLL_MS = 15000;
const OBS_PREFS = 'riverside.cast.obs';

const THEME_LABELS: Record<(typeof THEMES)[number], string> = {
  riverside: 'Riverside', safehouse: 'Safehouse', night: 'Night', bile: 'Bile',
};

const ELEMENT_INFO: { key: keyof LiveElements; label: string; help: string }[] = [
  { key: 'tank', label: 'Tank health', help: 'L4D1 shows tank health only to the tank, so this is on by default.' },
  { key: 'bosses', label: 'Tank and witch %', help: 'The game never shows these. Type them below.' },
  { key: 'survivors', label: 'Survivor health row', help: 'Off by default: the game already shows it while you spectate a survivor. Turn on for free cam or SourceTV.' },
  { key: 'infected', label: 'Infected lineup', help: 'Off by default: the game shows it while you spectate an infected. Turn on for free cam or SourceTV.' },
];

/** Live events worth a callout, with the card title each gets. */
const CALLOUT_KINDS: Record<string, (e: CastMatchView['events'][number]) => { title: string; text: string }> = {
  skeet: (e) => ({ title: 'Skeet', text: `${e.actor} skeeted ${e.target ?? 'a hunter'}` }),
  dp: (e) => ({ title: 'Big pounce', text: `${e.actor} pounced ${e.target ?? ''} for ${e.value}`.trim() }),
  tank_death: (e) => ({ title: 'Tank down', text: `${e.actor} finished the tank` }),
  tank_spawn: (e) => ({ title: 'Tank', text: `${e.actor} is on the tank` }),
  witch_killed: (e) => ({ title: 'Witch down', text: `${e.actor} killed the witch` }),
  witch_aggro: (e) => ({ title: 'Witch!', text: `${e.actor} startled the witch` }),
  death: (e) => ({ title: 'Survivor down', text: `${e.actor} was killed by ${e.target ?? 'the infected'}` }),
  incap: (e) => ({ title: 'Incapped', text: `${e.actor} went down to ${e.target ?? 'the infected'}` }),
  boom: (e) => ({ title: 'Boomed', text: `${e.actor} boomed ${e.target ?? 'the survivors'}` }),
  car_alarm: (e) => ({ title: 'Car alarm', text: `${e.actor} set off a car alarm` }),
};

function sideOfEvent(kind: string): 'survivor' | 'infected' {
  return ['skeet', 'tank_death', 'witch_killed', 'witch_aggro', 'death', 'incap', 'car_alarm'].includes(kind) ? 'survivor' : 'infected';
}

function useInterval(fn: () => void, ms: number) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const t = setInterval(() => ref.current(), ms);
    return () => clearInterval(t);
  }, [ms]);
}

export default function CastStudio() {
  const [panel, setPanel] = useState<StudioPanel | null>(null);
  const [state, setState] = useState<StudioState | null>(null);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feed, setFeed] = useState<OverlayFeed | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<StudioState | null>(null);

  const load = useCallback(async () => {
    try {
      const p = await studioApi.get();
      setPanel(p);
      setState((cur) => cur ?? p.studio);
      setDenied(false);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) setDenied(true);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useInterval(() => { void load(); }, PANEL_POLL_MS);
  useInterval(async () => {
    try { setFeed(await studioApi.feed()); } catch { /* keep the last */ }
  }, FEED_POLL_MS);
  useEffect(() => { void studioApi.feed().then(setFeed).catch(() => {}); }, []);

  const flush = useCallback(async () => {
    const next = pending.current;
    if (!next) return;
    pending.current = null;
    try {
      const r = await studioApi.save(next);
      setError(null);
      setFeed((f) => (f ? { ...f, studio: r.studio } : f));
    } catch (e) {
      setError(e instanceof ApiError && e.message === 'not_castable'
        ? 'You cannot put that match on air any more.' : 'Could not save. Check your connection.');
    }
  }, []);

  /** Change the state now on screen and save it shortly (or now). */
  const update = useCallback((fn: (s: StudioState) => StudioState, now = false) => {
    setState((cur) => {
      if (!cur) return cur;
      const next = fn(cur);
      pending.current = next;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => void flush(), now ? 0 : SAVE_DEBOUNCE_MS);
      return next;
    });
  }, [flush]);

  // OBS.
  const [obs, setObs] = useState<ObsClient | null>(null);
  const [obsStatus, setObsStatus] = useState<ObsStatus>('idle');
  const [obsError, setObsError] = useState<string | null>(null);
  const [obsScenes, setObsScenes] = useState<string[]>([]);
  const [obsProgram, setObsProgram] = useState('');
  const [obsSwitch, setObsSwitch] = useState(true);
  const prefs = useMemo(() => {
    try { return JSON.parse(localStorage.getItem(OBS_PREFS) ?? '{}') as { url?: string; password?: string; remember?: boolean }; } catch { return {}; }
  }, []);
  const [obsUrl, setObsUrl] = useState(prefs.url ?? 'ws://localhost:4455');
  const [obsPassword, setObsPassword] = useState(prefs.password ?? '');
  const [obsRemember, setObsRemember] = useState(prefs.remember ?? false);

  const obsConnect = async () => {
    setObsStatus('connecting');
    setObsError(null);
    try {
      const c = await connectObs({
        url: obsUrl, password: obsPassword,
        onProgramScene: (n) => setObsProgram(n),
        onClose: () => { setObs(null); setObsStatus('idle'); setObsError('OBS disconnected.'); },
      });
      setObs(c);
      setObsStatus('connected');
      setObsScenes(await c.sceneList());
      setObsProgram(await c.programScene());
      try {
        localStorage.setItem(OBS_PREFS, JSON.stringify(obsRemember ? { url: obsUrl, password: obsPassword, remember: true } : { url: obsUrl }));
      } catch { /* private window */ }
    } catch (e) {
      setObsStatus('failed');
      setObsError((e as Error).message);
    }
  };
  useEffect(() => () => obs?.close(), [obs]);

  const goScene = useCallback((scene: SceneKey) => {
    update((s) => ({ ...s, scene }), true);
    const name = panel?.obsScenes[scene];
    if (obs && obsSwitch && name && obsScenes.includes(name)) {
      obs.setProgramScene(name).catch((e: Error) => setObsError(e.message));
    }
  }, [update, obs, obsSwitch, obsScenes, panel]);

  // Number keys cut scenes (run of show), unless typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const i = e.key === '0' ? 9 : Number(e.key) - 1;
      if (Number.isInteger(i) && i >= 0 && i < SCENES.length) { e.preventDefault(); goScene(SCENES[i]!); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goScene]);

  if (denied) {
    return (
      <div class="page page--list">
        <PageHeader eyebrow="Casting" title="Caster studio" />
        <Empty>This page is for casters. Ask an admin if you should have it.</Empty>
      </div>
    );
  }
  if (!panel || !state) return <div class="page page--editor" />;

  const match = feed?.match ?? null;
  const origin = location.origin;
  const url = (scene: string) => `${origin}/overlay/${scene}?k=${encodeURIComponent(panel.key)}`;

  return (
    <div class="page page--editor studio">
      <PageHeader eyebrow="Casting" title="Caster studio">
        <p class="muted studio__lede">
          Pick what is on air, cut scenes with the number keys, and point OBS at your overlay links.
          Overlays follow this page within a second. <a href="/cast">Connect lines for spectating</a>
        </p>
      </PageHeader>
      {error && <p class="studio__error" role="alert">{error}</p>}
      <Preflight state={state} feed={feed} obsStatus={obsStatus} />
      <div class="studio__grid">
        <div class="studio__col">
          <OnAir panel={panel} state={state} update={update} />
          <ScenePad state={state} goScene={goScene} obsProgram={obsProgram} obsScenes={panel.obsScenes} />
          <Highlights state={state} match={match} onFire={async (c) => {
            try {
              const r = await studioApi.callout(c);
              setState((s) => (s ? { ...s, callout: r.studio.callout } : s));
              // A save queued before the fire must not carry the old (empty) callout.
              if (pending.current) pending.current = { ...pending.current, callout: r.studio.callout };
            } catch (e) { setError((e as Error).message); }
          }} onClear={() => update((s) => ({ ...s, callout: null }), true)} />
          <LiveToggles state={state} update={update} map={match?.currentMap ?? null} />
          <LowerThirdBox state={state} update={update} />
          <CountdownBox state={state} update={update} />
          <TeamsBox state={state} update={update} match={match} />
          <CastersBox state={state} update={update} />
          <ShowBox state={state} update={update} />
        </div>
        <div class="studio__col studio__col--side">
          <section class="panel studio__preview">
            <h3>Program preview</h3>
            <PreviewFrame src={url('program')} />
            <p class="muted studio__hint">What /overlay/program shows right now. Transparent parts show as checkerboard.</p>
          </section>
          <ObsBox
            status={obsStatus} error={obsError} url={obsUrl} setUrl={setObsUrl} password={obsPassword} setPassword={setObsPassword}
            remember={obsRemember} setRemember={setObsRemember}
            connect={obsConnect} disconnect={() => { obs?.close(); setObs(null); setObsStatus('idle'); }}
            scenes={obsScenes} program={obsProgram} wanted={panel.obsScenes} switchOn={obsSwitch} setSwitch={setObsSwitch}
          />
          <LinksBox url={url} onNewKey={async () => {
            try { const r = await studioApi.newKey(); setPanel((p) => (p ? { ...p, key: r.key } : p)); } catch (e) { setError((e as Error).message); }
          }} />
          <PrepBox matchId={match?.id ?? null} />
          <RunOfShow />
        </div>
      </div>
    </div>
  );
}

type Update = (fn: (s: StudioState) => StudioState, now?: boolean) => void;

/* ---------- pre-flight ---------- */

function Preflight({ state, feed, obsStatus }: { state: StudioState; feed: OverlayFeed | null; obsStatus: ObsStatus }) {
  const match = feed?.match ?? null;
  const picked = state.matchId !== null || state.bookingId !== null;
  const liveOk = match?.state === 'live' ? (feed?.live ? feed.live.ageMs < 5000 : null) : undefined;
  const items: { label: string; ok: boolean | null; note: string }[] = [
    { label: 'Match on air', ok: picked && !!match, note: !picked ? 'Pick one below' : match ? `#${match.id}` : state.bookingId ? 'Waiting for the first game' : 'Not visible to you' },
    {
      label: 'Live round data', ok: liveOk === undefined ? null : liveOk,
      note: liveOk === undefined ? 'Only while a match is live' : liveOk ? 'Arriving' : 'None yet: between rounds, or the push is off on that server',
    },
    { label: 'Casters named', ok: state.casters.some((c) => c.name), note: state.casters.filter((c) => c.name).map((c) => c.name).join(', ') || 'Add yourself below' },
    { label: 'OBS', ok: obsStatus === 'connected' ? true : null, note: obsStatus === 'connected' ? 'Connected' : 'Optional: connect to cut OBS scenes from here' },
    { label: 'Countdown', ok: state.countdownTo ? true : null, note: state.countdownTo ? new Date(state.countdownTo).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Not set' },
  ];
  return (
    <ul class="studio__preflight" aria-label="Pre-flight checklist">
      {items.map((i) => (
        <li key={i.label} class={i.ok === true ? 'is-ok' : i.ok === false ? 'is-bad' : 'is-na'}>
          <span class="studio__pf-dot" aria-hidden="true" />
          <span class="studio__pf-label">{i.label}</span>
          <span class="studio__pf-note">{i.note}</span>
        </li>
      ))}
    </ul>
  );
}

/* ---------- on air ---------- */

function OnAir({ panel, state, update }: { panel: StudioPanel; state: StudioState; update: Update }) {
  const live = panel.matches.filter((m) => m.state === 'live' || m.state === 'configuring');
  const recent = panel.matches.filter((m) => m.state === 'completed');
  const pickMatch = (id: number | null) => update((s) => ({ ...s, matchId: id, bookingId: null, overrides: { a: {}, b: {} }, bosses: { tank: null, witch: null, map: null } }), true);
  const pickBooking = (id: number) => update((s) => ({ ...s, bookingId: id, matchId: null, overrides: { a: {}, b: {} }, bosses: { tank: null, witch: null, map: null } }), true);
  const row = (m: StudioPanel['matches'][number]) => {
    const on = state.bookingId === null && state.matchId === m.id;
    return (
      <button key={m.id} type="button" class={`studio__pick${on ? ' is-on' : ''}`} style={{ '--tint': campaignTint(m.campaign) } as Record<string, string>}
        onClick={() => pickMatch(on ? null : m.id)} aria-pressed={on}>
        <span class="studio__pick-head">
          <b>#{m.id}</b> {m.campaignName}
          <span class={`studio__state studio__state--${m.state}`}>{m.state === 'configuring' ? 'Setting up' : m.state === 'live' ? 'Live' : 'Ended'}</span>
          {m.kind !== 'pug' && <span class="studio__kind">{m.kind}</span>}
        </span>
        <span class="studio__pick-teams">
          <span>{m.teamA.join(', ') || 'Team A'}</span>
          <b class="num">{m.scoreA} - {m.scoreB}</b>
          <span>{m.teamB.join(', ') || 'Team B'}</span>
        </span>
      </button>
    );
  };
  return (
    <section class="panel">
      <h3>On air</h3>
      {live.length === 0 && panel.bookings.length === 0 && recent.length === 0 && (
        <p class="muted">Nothing to cast yet. PUGs show up as soon as a queue pops; scrims show when both captains invite you.</p>
      )}
      {live.length > 0 && <div class="studio__picks">{live.map(row)}</div>}
      {panel.bookings.length > 0 && (
        <>
          <p class="eyebrow studio__sub">Scrims you were invited to (follows each game)</p>
          <div class="studio__picks">
            {panel.bookings.map((b) => {
              const on = state.bookingId === b.id;
              return (
                <button key={b.id} type="button" class={`studio__pick${on ? ' is-on' : ''}`} onClick={() => (on ? pickMatch(null) : pickBooking(b.id))} aria-pressed={on}>
                  <span class="studio__pick-head"><b>{b.sideA}</b> vs <b>{b.sideB}</b><span class="studio__kind">{b.purpose}</span></span>
                  <span class="studio__pick-teams"><span>{new Date(b.startsAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</span><span>{b.latestMatchId ? `Game #${b.latestMatchId}` : 'No game yet'}</span></span>
                </button>
              );
            })}
          </div>
        </>
      )}
      {recent.length > 0 && (
        <>
          <p class="eyebrow studio__sub">Ended in the last six hours</p>
          <div class="studio__picks">{recent.map(row)}</div>
        </>
      )}
    </section>
  );
}

/* ---------- scenes ---------- */

function ScenePad({ state, goScene, obsProgram, obsScenes }: {
  state: StudioState; goScene: (s: SceneKey) => void; obsProgram: string; obsScenes: Record<string, string>;
}) {
  return (
    <section class="panel">
      <h3>Scenes</h3>
      <div class="studio__scenes">
        {SCENES.map((s, i) => {
          const on = state.scene === s;
          const inObs = obsProgram && obsScenes[s] === obsProgram;
          return (
            <button key={s} type="button" class={`studio__scene${on ? ' is-on' : ''}`} onClick={() => goScene(s)} aria-pressed={on}>
              <kbd>{i === 9 ? 0 : i + 1}</kbd>
              <span>{SCENE_LABELS[s]}</span>
              {inObs && <em>OBS</em>}
            </button>
          );
        })}
      </div>
    </section>
  );
}

/* ---------- highlights ---------- */

function Highlights({ state, match, onFire, onClear }: {
  state: StudioState; match: CastMatchView | null;
  onFire: (c: { title: string; text: string; team: 'a' | 'b' | null }) => void; onClear: () => void;
}) {
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [team, setTeam] = useState<'a' | 'b' | null>(null);
  const events = (match?.events ?? []).filter((e) => CALLOUT_KINDS[e.kind]);
  const showing = state.callout && Date.now() - Date.parse(state.callout.at) < 8000;
  return (
    <section class="panel">
      <h3>Highlights</h3>
      <p class="muted studio__hint">Fire a card on the gameplay scene for eight seconds. Newest plays first.</p>
      {events.length > 0 ? (
        <ul class="studio__events">
          {events.slice(0, 8).map((e) => {
            const c = CALLOUT_KINDS[e.kind]!(e);
            return (
              <li key={e.seq} class={`studio__event studio__event--${sideOfEvent(e.kind)}`}>
                <span><b>{c.title}</b> {c.text}</span>
                <button type="button" class="btn btn--sm" onClick={() => onFire({ ...c, team: e.actorTeam })}>Fire</button>
              </li>
            );
          })}
        </ul>
      ) : <p class="muted">Live events show here while a match is on air.</p>}
      <div class="studio__form studio__callout">
        <input value={title} maxLength={24} placeholder="Title, e.g. Clutch" onInput={(e) => setTitle(e.currentTarget.value)} aria-label="Callout title" />
        <input value={text} maxLength={100} placeholder="Line under it" onInput={(e) => setText(e.currentTarget.value)} aria-label="Callout text" />
        <select value={team ?? ''} onChange={(e) => setTeam((e.currentTarget.value || null) as 'a' | 'b' | null)} aria-label="Team colour">
          <option value="">No team</option>
          <option value="a">{match?.teams.a.name ?? 'Team A'}</option>
          <option value="b">{match?.teams.b.name ?? 'Team B'}</option>
        </select>
        <button type="button" class="btn btn--sm" disabled={!title.trim()} onClick={() => { onFire({ title: title.trim(), text: text.trim(), team }); }}>Fire</button>
        {showing && <button type="button" class="btn btn--ghost btn--sm" onClick={onClear}>Clear</button>}
      </div>
    </section>
  );
}

/* ---------- toggles ---------- */

function LiveToggles({ state, update, map }: { state: StudioState; update: Update; map: string | null }) {
  const stale = state.bosses.map !== null && map !== null && state.bosses.map !== map;
  const tank = stale ? null : state.bosses.tank;
  const witch = stale ? null : state.bosses.witch;
  const num = (v: string): number | null => {
    if (v.trim() === '') return null;
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
  };
  return (
    <section class="panel">
      <h3>Gameplay overlay</h3>
      <p class="muted studio__hint">Only what the game does not already show. Each live element has its own switch.</p>
      <div class="studio__toggles">
        {ELEMENT_INFO.map((el) => (
          <label key={el.key} class="studio__toggle">
            <input type="checkbox" checked={state.elements[el.key]}
              onChange={(e) => { const on = e.currentTarget.checked; update((s) => ({ ...s, elements: { ...s.elements, [el.key]: on } }), true); }} />
            <span><b>{el.label}</b><em>{el.help}</em></span>
          </label>
        ))}
      </div>
      <div class="studio__form studio__row3">
        <label>Tank %<input inputMode="numeric" value={tank ?? ''} placeholder="-"
          onInput={(e) => { const v = num(e.currentTarget.value); update((s) => ({ ...s, bosses: { tank: v, witch: stale ? null : s.bosses.witch, map } })); }} /></label>
        <label>Witch %<input inputMode="numeric" value={witch ?? ''} placeholder="-"
          onInput={(e) => { const v = num(e.currentTarget.value); update((s) => ({ ...s, bosses: { witch: v, tank: stale ? null : s.bosses.tank, map } })); }} /></label>
        <label>Scorebug
          <select value={state.scorebugAt} onChange={(e) => { const v = e.currentTarget.value === 'bottom' ? 'bottom' : 'top'; update((s) => ({ ...s, scorebugAt: v }), true); }}>
            <option value="top">Top centre</option>
            <option value="bottom">Bottom centre</option>
          </select>
        </label>
      </div>
    </section>
  );
}

function LowerThirdBox({ state, update }: { state: StudioState; update: Update }) {
  const lt = state.lowerThird;
  return (
    <section class="panel">
      <h3>Lower third</h3>
      <div class="studio__form">
        <input value={lt.title} maxLength={80} placeholder="Title" aria-label="Lower third title"
          onInput={(e) => { const v = e.currentTarget.value; update((s) => ({ ...s, lowerThird: { ...s.lowerThird, title: v } })); }} />
        <input value={lt.text} maxLength={140} placeholder="Text" aria-label="Lower third text"
          onInput={(e) => { const v = e.currentTarget.value; update((s) => ({ ...s, lowerThird: { ...s.lowerThird, text: v } })); }} />
        <button type="button" class={`btn btn--sm${lt.show ? '' : ' btn--ghost'}`}
          onClick={() => update((s) => ({ ...s, lowerThird: { ...s.lowerThird, show: !s.lowerThird.show } }), true)}>
          {lt.show ? 'Hide' : 'Show'}
        </button>
      </div>
    </section>
  );
}

function CountdownBox({ state, update }: { state: StudioState; update: Update }) {
  const set = (min: number) => update((s) => ({ ...s, countdownTo: new Date(Date.now() + min * 60_000).toISOString() }), true);
  return (
    <section class="panel">
      <h3>Countdown</h3>
      <p class="muted studio__hint">Shown on Starting soon and Be right back.</p>
      <div class="studio__chips">
        {[2, 5, 10, 15, 30].map((m) => <button key={m} type="button" class="chip" onClick={() => set(m)}>{m} min</button>)}
        {state.countdownTo && <button type="button" class="btn btn--ghost btn--sm" onClick={() => update((s) => ({ ...s, countdownTo: null }), true)}>Clear</button>}
      </div>
    </section>
  );
}

function TeamsBox({ state, update, match }: { state: StudioState; update: Update; match: CastMatchView | null }) {
  const setO = (t: 'a' | 'b', patch: Partial<TeamOverride>) =>
    update((s) => {
      const o: TeamOverride = { ...s.overrides[t], ...patch };
      for (const k of Object.keys(o) as (keyof TeamOverride)[]) if (o[k] === undefined || o[k] === '') delete o[k];
      return { ...s, overrides: { ...s.overrides, [t]: o } };
    });
  return (
    <section class="panel">
      <h3>Teams</h3>
      <p class="muted studio__hint">An override wins over live data until you clear it.</p>
      {(['a', 'b'] as const).map((t) => {
        const o = state.overrides[t];
        const live = match?.teams[t];
        const any = Object.keys(o).length > 0;
        return (
          <div key={t} class="studio__team">
            <span class="studio__team-key" style={{ background: o.color ?? live?.color ?? '#555' }}>{t.toUpperCase()}</span>
            <input value={o.name ?? ''} placeholder={live?.name ?? `Team ${t.toUpperCase()}`} maxLength={40} aria-label={`Team ${t} name`}
              class={o.name !== undefined ? 'is-over' : ''} onInput={(e) => setO(t, { name: e.currentTarget.value || undefined })} />
            <input value={o.tag ?? ''} placeholder={live?.tag ?? t.toUpperCase()} maxLength={8} aria-label={`Team ${t} tag`} class={`studio__tag${o.tag !== undefined ? ' is-over' : ''}`}
              onInput={(e) => setO(t, { tag: e.currentTarget.value || undefined })} />
            <input type="color" value={o.color ?? live?.color ?? '#5b8fd9'} aria-label={`Team ${t} colour`}
              onInput={(e) => setO(t, { color: e.currentTarget.value })} />
            <input inputMode="numeric" value={o.score ?? ''} placeholder={String(live?.score ?? 0)} aria-label={`Team ${t} score override`}
              class={`studio__score${o.score !== undefined ? ' is-over' : ''}`}
              onInput={(e) => { const v = e.currentTarget.value.trim(); const n = Number(v); setO(t, { score: v === '' || !Number.isInteger(n) || n < 0 ? undefined : n }); }} />
            {any && <button type="button" class="btn btn--ghost btn--sm" onClick={() => update((s) => ({ ...s, overrides: { ...s.overrides, [t]: {} } }), true)}>Clear</button>}
          </div>
        );
      })}
    </section>
  );
}

function CastersBox({ state, update }: { state: StudioState; update: Update }) {
  const set = (i: number, patch: Partial<StudioState['casters'][number]>) =>
    update((s) => ({ ...s, casters: s.casters.map((c, j) => (j === i ? { ...c, ...patch } : c)) }));
  return (
    <section class="panel">
      <h3>Casters</h3>
      <p class="muted studio__hint">A cam link (VDO.Ninja view link or similar) is placed in its frame by the OBS scene collection.</p>
      {state.casters.map((c, i) => (
        <div key={i} class="studio__form studio__caster">
          <input value={c.name} maxLength={40} placeholder="Name" aria-label={`Caster ${i + 1} name`} onInput={(e) => set(i, { name: e.currentTarget.value })} />
          <input value={c.handle} maxLength={40} placeholder="@handle" aria-label={`Caster ${i + 1} handle`} onInput={(e) => set(i, { handle: e.currentTarget.value })} />
          <input value={c.camUrl} maxLength={500} placeholder="Cam link (optional)" aria-label={`Caster ${i + 1} cam link`} onInput={(e) => set(i, { camUrl: e.currentTarget.value })} />
          <button type="button" class="btn btn--ghost btn--sm" onClick={() => update((s) => ({ ...s, casters: s.casters.filter((_, j) => j !== i) }), true)}>Remove</button>
        </div>
      ))}
      {state.casters.length < MAX_CASTERS && (
        <button type="button" class="btn btn--ghost btn--sm" onClick={() => update((s) => ({ ...s, casters: [...s.casters, { name: '', handle: '', camUrl: '' }] }), true)}>Add caster</button>
      )}
    </section>
  );
}

function ShowBox({ state, update }: { state: StudioState; update: Update }) {
  return (
    <section class="panel">
      <h3>Show</h3>
      <div class="studio__form studio__row3">
        <label>Title<input value={state.title} maxLength={80} onInput={(e) => { const v = e.currentTarget.value; update((s) => ({ ...s, title: v })); }} /></label>
        <label>Subtitle<input value={state.subtitle} maxLength={80} placeholder="e.g. Friday night PUGs" onInput={(e) => { const v = e.currentTarget.value; update((s) => ({ ...s, subtitle: v })); }} /></label>
        <label>Theme
          <select value={state.theme} onChange={(e) => { const v = e.currentTarget.value as StudioState['theme']; update((s) => ({ ...s, theme: v }), true); }}>
            {THEMES.map((t) => <option key={t} value={t}>{THEME_LABELS[t]}</option>)}
          </select>
        </label>
      </div>
    </section>
  );
}

/* ---------- side column ---------- */

/** The program overlay at 1920x1080, scaled to the column's width. */
function PreviewFrame({ src }: { src: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.28);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setScale(el.clientWidth / 1920));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div class="studio__frame" ref={box}>
      <iframe title="Program preview" src={src} loading="lazy" style={{ transform: `scale(${scale})` }} />
    </div>
  );
}

function ObsBox(p: {
  status: ObsStatus; error: string | null; url: string; setUrl: (v: string) => void; password: string; setPassword: (v: string) => void;
  remember: boolean; setRemember: (v: boolean) => void; connect: () => void; disconnect: () => void;
  scenes: string[]; program: string; wanted: Record<string, string>; switchOn: boolean; setSwitch: (v: boolean) => void;
}) {
  const missing = Object.values(p.wanted).filter((n) => !p.scenes.includes(n));
  return (
    <section class="panel">
      <h3>OBS</h3>
      {p.status !== 'connected' ? (
        <>
          <p class="muted studio__hint">Optional. In OBS: Tools, WebSocket Server Settings, enable it and copy the password.</p>
          <div class="studio__form">
            <input value={p.url} onInput={(e) => p.setUrl(e.currentTarget.value)} aria-label="OBS WebSocket address" />
            <input type="password" value={p.password} placeholder="Password" onInput={(e) => p.setPassword(e.currentTarget.value)} aria-label="OBS WebSocket password" />
            <button type="button" class="btn btn--sm" disabled={p.status === 'connecting'} onClick={p.connect}>{p.status === 'connecting' ? 'Connecting' : 'Connect'}</button>
          </div>
          <label class="studio__toggle studio__toggle--small"><input type="checkbox" checked={p.remember} onChange={(e) => p.setRemember(e.currentTarget.checked)} /><span>Remember the password on this computer</span></label>
        </>
      ) : (
        <>
          <p class="studio__obs-ok">Connected. Program: <b>{p.program || 'unknown'}</b></p>
          <label class="studio__toggle studio__toggle--small"><input type="checkbox" checked={p.switchOn} onChange={(e) => p.setSwitch(e.currentTarget.checked)} /><span>Cut the matching OBS scene when I pick a scene here</span></label>
          {missing.length > 0 && <p class="muted studio__hint">Missing in OBS: {missing.join(', ')}. Import the scene collection below to get them.</p>}
          <button type="button" class="btn btn--ghost btn--sm" onClick={p.disconnect}>Disconnect</button>
        </>
      )}
      {p.error && <p class="studio__error">{p.error}</p>}
      <p class="studio__dl"><a class="btn btn--ghost btn--sm" href="/api/cast/studio/obs-collection" download>Download OBS scene collection</a></p>
      <p class="muted studio__hint">OBS: Scene Collection, Import, pick the file. Every scene is a browser source on your own links.</p>
    </section>
  );
}

function LinksBox({ url, onNewKey }: { url: (scene: string) => string; onNewKey: () => void }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (k: string) => {
    try { await navigator.clipboard.writeText(url(k)); setCopied(k); setTimeout(() => setCopied(null), 1500); } catch { /* select by hand */ }
  };
  const all = ['program', ...SCENES, ...LAYERS] as const;
  return (
    <section class="panel">
      <h3>Overlay links</h3>
      <p class="muted studio__hint">1920 x 1080 browser sources. Program follows this page; the others are one scene each. Keep these private: anyone with a link sees your feed.</p>
      <ul class="studio__links">
        {all.map((k) => (
          <li key={k}>
            <span>{k === 'program' ? 'Program (follows you)' : SCENE_LABELS[k]}</span>
            <button type="button" class="btn btn--ghost btn--sm" onClick={() => void copy(k)}>{copied === k ? 'Copied' : 'Copy'}</button>
          </li>
        ))}
      </ul>
      <button type="button" class="btn btn--ghost btn--sm" onClick={onNewKey}>New links (old ones stop working)</button>
    </section>
  );
}

function PrepBox({ matchId }: { matchId: number | null }) {
  const [sheet, setSheet] = useState<PrepSheet | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setSheet(null);
    if (!open || matchId === null) return;
    const ctl = new AbortController();
    studioApi.prep(matchId, ctl.signal).then(setSheet).catch(() => {});
    return () => ctl.abort();
  }, [matchId, open]);
  return (
    <section class="panel">
      <h3>Prep sheet</h3>
      {matchId === null ? <p class="muted">Put a match on air to see its prep sheet.</p> : !open ? (
        <button type="button" class="btn btn--ghost btn--sm" onClick={() => setOpen(true)}>Open prep sheet</button>
      ) : !sheet ? <p class="muted">Loading</p> : (
        <div class="studio__prep">
          {(['a', 'b'] as const).map((t) => (
            <div key={t}>
              <p class="eyebrow">Team {t.toUpperCase()}</p>
              {sheet.players.filter((p) => p.team === t).map((p) => (
                <div key={p.steamid} class="studio__prep-p">
                  <p><b>{p.name}</b> <span class="muted">{p.matches} PUGs</span> <span class="studio__form-dots">{p.form.map((f, i) => <i key={i} class={`f-${f}`}>{f}</i>)}</span></p>
                  <p class="muted">Per PUG: {p.avg.sidmg} SI dmg, {p.avg.ck} commons, {p.avg.skeets} skeets, {p.avg.dps} DPs, {p.avg.tankDmg} tank dmg</p>
                  {p.best.length > 0 && <p class="muted">Best: {p.best.map((b) => `${b.value} ${b.label.toLowerCase()} (#${b.matchId})`).join(', ')}</p>}
                  {p.campaigns.length > 0 && <p class="muted">Most played: {p.campaigns.map((c) => `${c.name} ${c.won}/${c.played}`).join(', ')}</p>}
                </div>
              ))}
            </div>
          ))}
          {sheet.rivalries.length > 0 && (
            <div>
              <p class="eyebrow">Head to head</p>
              {sheet.rivalries.map((r, i) => <p key={i}>{r.a} vs {r.b}: met {r.met} times, {r.a} won {r.aWon}</p>)}
            </div>
          )}
          {sheet.duos.length > 0 && (
            <div>
              <p class="eyebrow">Duos</p>
              {sheet.duos.map((d, i) => <p key={i}>{d.a} and {d.b}: {d.together} PUGs together, won {d.won}</p>)}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function RunOfShow() {
  return (
    <section class="panel studio__ros">
      <h3>Run of show</h3>
      <ol>
        <li><kbd>1</kbd> Starting soon with a countdown</li>
        <li><kbd>2</kbd> Casters on cam, introduce the match</li>
        <li><kbd>6</kbd> Lineups, talk through the rosters (prep sheet)</li>
        <li><kbd>4</kbd> Map intro before each chapter</li>
        <li><kbd>3</kbd> Gameplay; fire highlights as they happen</li>
        <li><kbd>5</kbd> Chapter scores between maps</li>
        <li><kbd>8</kbd> Be right back for pauses</li>
        <li><kbd>7</kbd> Match stats, then <kbd>9</kbd> Winner</li>
        <li><kbd>0</kbd> Ending</li>
      </ol>
      <p class="muted studio__hint">Number keys cut scenes anywhere on this page except while typing.</p>
    </section>
  );
}
