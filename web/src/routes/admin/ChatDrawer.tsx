import { Fragment } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { ApiError, modApi, type ChatLineView, type ChatSendBody } from '../../api';
import { useFetch } from '../../hooks/useFetch';
import { useHubEvent } from '../../hooks/useHubEvent';
import { Empty } from '../../components/bits';

const TEAM_CLASS: Record<number, string> = { 1: 'chat-line--spec', 2: 'chat-line--surv', 3: 'chat-line--inf' };
const TEAM_NAME: Record<string, string> = { '1': 'Spectators', '2': 'Survivors', '3': 'Infected' };

type Mode = { kind: 'all' } | { kind: 'team'; team: 1 | 2 | 3 } | { kind: 'player'; steamid: string; name: string }
  | { kind: 'pick' };
type Roster = { state: 'loading' } | { state: 'ready'; players: { steamid: string; name: string }[] } | { state: 'error'; error: string };

/**
 * The Live board's chat drawer: one server's chat, live, and a box that sends
 * to everyone, a team, or one player. Staff see team chat too (owner ruling
 * 2026-09-28). Opened by ?chat=<serverId>, so a mod call card or the admin
 * feed can link straight into it.
 */
export function ChatDrawer({ serverId, onPick, onClose }: {
  serverId: number; onPick: (id: number) => void; onClose: () => void;
}) {
  const servers = useFetch((s) => modApi.chatServers(s), []);
  const [lines, setLines] = useState<ChatLineView[]>([]);
  // Opened during a live match, the drawer shows that match only; Show
  // earlier chat pages back from there, any match, with a divider wherever
  // the match changes (owner, 2026-09-29).
  const [currentMatchId, setCurrentMatchId] = useState<number | null>(null);
  const [older, setOlder] = useState<ChatLineView[]>([]);
  const [earlierLeft, setEarlierLeft] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  // Height below the viewport's top before older lines were put above it,
  // so prepending leaves staff looking at the same line.
  const keepFromBottom = useRef<number | null>(null);
  const olderCount = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: 'all' });
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [roster, setRoster] = useState<Roster>({ state: 'loading' });
  const logRef = useRef<HTMLDivElement>(null);
  // Whether the log sat at (or within 40px of) the bottom as of the last
  // scroll. Only then does a new line pull it down: staff scrolled up to read
  // history are left where they are.
  const stick = useRef(true);

  // Which server the drawer shows right now, in a ref rather than the
  // `serverId` prop: a `load` call closes over the prop as it was when the
  // call was made, and never sees it change, so only a ref can tell a
  // response that arrives after staff switched servers that it is stale.
  const shownId = useRef(serverId);
  // The in-flight /chat/:id request, if any, so switching servers again (or
  // the same server refreshing twice) can abort the one that lost the race
  // instead of just letting it land after being ignored.
  const linesAbort = useRef<AbortController | null>(null);

  // A delivery report changes an old row, so a refresh re-reads the whole
  // window rather than only what is after the last id.
  const load = async () => {
    const id = serverId;
    linesAbort.current?.abort();
    const ctrl = new AbortController();
    linesAbort.current = ctrl;
    try {
      const r = await modApi.chatLines(id, ctrl.signal);
      if (shownId.current !== id) return; // the drawer moved to another server meanwhile
      setLines(r.lines);
      setCurrentMatchId(r.currentMatchId ?? null);
      // Once older pages are loaded, their own answer says what is left.
      if (olderCount.current === 0) setEarlierLeft(r.hasEarlier === true);
      setError(null);
    } catch (err) {
      if (shownId.current !== id) return;
      // An abort is this request losing a race, not a failure to report.
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError('Could not load the chat.');
    }
  };
  useEffect(() => {
    shownId.current = serverId;
    stick.current = true;
    setMode({ kind: 'all' });
    setLines([]);
    setOlder([]);
    olderCount.current = 0;
    setEarlierLeft(false);
    setCurrentMatchId(null);
    void load();
    return () => linesAbort.current?.abort();
  }, [serverId]);
  useHubEvent(['server_chat'], () => { void load(); });
  // Keyed on the last line's id, not the count: a busy server's window is
  // always 200 lines, so the count stops changing while the chat goes on.
  const lastId = lines.length > 0 ? lines[lines.length - 1].id : 0;
  useEffect(() => {
    const log = logRef.current;
    if (log && stick.current) log.scrollTop = log.scrollHeight;
  }, [lastId]);
  useLayoutEffect(() => {
    const log = logRef.current;
    if (log && keepFromBottom.current !== null) log.scrollTop = log.scrollHeight - keepFromBottom.current;
    keepFromBottom.current = null;
  }, [older.length]);

  // Older lines stop where the current view starts: a refresh can move that
  // start (a match ends, a new one begins) and nothing is shown twice.
  const firstCurrent = lines.length > 0 ? lines[0].id : Number.MAX_SAFE_INTEGER;
  const shown = [...older.filter((o) => o.id < firstCurrent), ...lines];

  const loadEarlier = async () => {
    const id = serverId;
    const before = shown.length > 0 ? shown[0].id : Number.MAX_SAFE_INTEGER;
    setLoadingEarlier(true);
    try {
      const r = await modApi.chatEarlier(id, before, new AbortController().signal);
      if (shownId.current !== id) return;
      const log = logRef.current;
      if (log) keepFromBottom.current = log.scrollHeight - log.scrollTop;
      setOlder((o) => {
        const next = [...r.lines, ...o];
        olderCount.current = next.length;
        return next;
      });
      setEarlierLeft(r.hasEarlier);
    } catch {
      if (shownId.current === id) setError('Could not load earlier chat.');
    } finally {
      if (shownId.current === id) setLoadingEarlier(false);
    }
  };

  const onScroll = () => {
    const log = logRef.current;
    if (log) stick.current = log.scrollHeight - log.scrollTop - log.clientHeight <= 40;
  };

  // "Whisper...": a /mod caller, a reported player or someone only on voice
  // has no chat line to click, so list who is on the server now.
  const pickPlayer = async () => {
    const id = serverId;
    setMode({ kind: 'pick' });
    setRoster({ state: 'loading' });
    try {
      const r = await modApi.chatPlayers(id);
      if (shownId.current === id) setRoster({ state: 'ready', players: r.players });
    } catch (err) {
      if (shownId.current === id) setRoster({ state: 'error', error: err instanceof ApiError ? err.message : 'Could not load the players.' });
    }
  };

  const send = async () => {
    const message = text.trim();
    if (!message || mode.kind === 'pick') return;
    const body: ChatSendBody = mode.kind === 'all' ? { to: 'all', message }
      : mode.kind === 'team' ? { to: 'team', team: mode.team, message }
      : { to: 'player', steamid: mode.steamid, message };
    setSending(true);
    try {
      await modApi.chatSend(serverId, body);
      setText('');
      setError(null);
      await load();
    } catch (err) {
      // The row was stored before the send failed and is now marked -1, so
      // re-read to show it; the error is set after, since a good load clears it.
      const msg = err instanceof ApiError ? err.message : 'Could not send.';
      await load();
      if (shownId.current === serverId) setError(msg);
    } finally {
      setSending(false);
    }
  };

  const modeValue = mode.kind === 'team' ? `team:${mode.team}` : mode.kind === 'pick' ? 'whisper' : mode.kind;
  return (
    <aside class="chat-drawer" aria-label="Server chat">
      <header class="chat-drawer__head">
        <label>
          <span class="sr-only">Server</span>
          <select aria-label="Server" value={String(serverId)}
            onChange={(e) => onPick(Number((e.target as HTMLSelectElement).value))}>
            {(servers.data?.servers ?? [{ id: serverId, name: `Server ${serverId}`, state: 'idle', lastAt: null }]).map((s) => (
              <option key={s.id} value={String(s.id)}>{s.name} ({s.state})</option>
            ))}
          </select>
        </label>
        <button type="button" class="chip" aria-label="Close chat" onClick={onClose}>×</button>
      </header>
      <div class="chat-log" role="log" ref={logRef} onScroll={onScroll}>
        {earlierLeft && (
          <button type="button" class="chip chat-earlier" disabled={loadingEarlier} onClick={() => { void loadEarlier(); }}>
            Show earlier chat
          </button>
        )}
        {shown.length === 0 && <Empty>{currentMatchId !== null ? 'No chat in this match yet.' : 'No chat yet.'}</Empty>}
        {shown.map((l, i) => (
          <Fragment key={l.id}>
            {(i === 0 || shown[i - 1].matchId !== l.matchId) && <Divider matchId={l.matchId} />}
            <Line line={l} onName={(steamid, n) => setMode({ kind: 'player', steamid, name: n })} />
          </Fragment>
        ))}
      </div>
      {error && <p class="error">{error}</p>}
      <form class="chat-send" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        {mode.kind === 'player' ? (
          <span class="chat-mode">
            Whisper to {mode.name}{' '}
            <button type="button" class="chip" onClick={() => setMode({ kind: 'all' })}>Cancel</button>
          </span>
        ) : (
          <label>
            <span class="sr-only">Send to</span>
            <select aria-label="Send to" value={modeValue}
              onChange={(e) => {
                const v = (e.target as HTMLSelectElement).value;
                if (v === 'whisper') { void pickPlayer(); return; }
                setMode(v === 'all' ? { kind: 'all' } : { kind: 'team', team: Number(v.split(':')[1]) as 1 | 2 | 3 });
              }}>
              <option value="all">All</option>
              <option value="team:2">Survivors</option>
              <option value="team:3">Infected</option>
              <option value="team:1">Spectators</option>
              <option value="whisper">Whisper...</option>
            </select>
          </label>
        )}
        {mode.kind === 'pick' && (
          <div class="chat-pick" aria-label="Whisper to">
            {roster.state === 'loading' && <span class="muted">Loading players...</span>}
            {roster.state === 'error' && <span class="error">{roster.error}</span>}
            {roster.state === 'ready' && roster.players.length === 0 && <span class="muted">Nobody is on the server.</span>}
            {roster.state === 'ready' && roster.players.map((p) => (
              <button key={p.steamid} type="button" class="chip"
                onClick={() => setMode({ kind: 'player', steamid: p.steamid, name: p.name })}>{p.name}</button>
            ))}
          </div>
        )}
        <input aria-label="Message" maxLength={180} value={text}
          onInput={(e) => setText((e.target as HTMLInputElement).value)} />
        <button type="submit" disabled={sending || !text.trim() || mode.kind === 'pick'}>Send</button>
      </form>
    </aside>
  );
}

/** Where one match's chat starts, or chat outside any match. */
function Divider({ matchId }: { matchId: number | null }) {
  return (
    <div class="chat-divider" role="separator">
      {matchId !== null ? <a href={`/match/${matchId}`}>Match #{matchId}</a> : <span>Between matches</span>}
    </div>
  );
}

function Line({ line: l, onName }: { line: ChatLineView; onName: (steamid: string, name: string) => void }) {
  const time = new Date(l.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (l.kind === 'staff_out') {
    const to = l.to?.kind === 'player' ? `whisper to ${l.to.name ?? l.to.value}`
      : l.to?.kind === 'team' ? `to ${TEAM_NAME[l.to.value ?? ''] ?? 'team'}` : 'to everyone';
    const status = l.delivered === null ? 'sending' : l.delivered === -1 ? 'not sent'
      : l.delivered === 0 ? 'not on the server' : `delivered to ${l.delivered}`;
    return (
      <div class="chat-line chat-line--staff">
        <span class="muted">{time}</span> <strong>[Staff] {l.name}</strong> <span class="muted">({to})</span>:{' '}
        <span class="chat-line__msg">{l.message}</span>{' '}
        <span class="muted">{status}</span>
      </div>
    );
  }
  // Lead with the site name the Live board's rosters use; the in-game name,
  // when it differs, is a hover away (owner, 2026-09-30: inline was cluttered).
  const who = l.siteName ?? l.name ?? l.steamid ?? '?';
  const title = l.name && l.name !== who ? `In game: ${l.name}` : undefined;
  return (
    <div class={`chat-line ${TEAM_CLASS[l.team ?? 0] ?? ''}${l.kind === 'staff_in' ? ' chat-line--to-staff' : ''}`}>
      <span class="muted">{time}</span>{' '}
      {l.steamid
        ? <button type="button" class="linkish" title={title} onClick={() => onName(l.steamid!, who)}>{who}</button>
        : <strong title={title}>{who}</strong>}
      {l.scope === 'team' && <>{' '}<span class="muted">(team)</span></>}
      {l.kind === 'staff_in' && <span class="chat-tag">to staff</span>}
      : <span class="chat-line__msg">{l.message}</span>
    </div>
  );
}
