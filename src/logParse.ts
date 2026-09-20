import { steamId64Of } from './steamId.js';

const TOKEN_RE = /^[0-9a-f]{32}$/;

export const PHASE_STATES = ['live', 'paused', 'readyup', 'roundover', 'loading'] as const;
export type PhaseState = typeof PHASE_STATES[number];
export interface Phase {
  state: PhaseState;
  /** Who is charged for a pause, or null: a disconnect pause, an admin, or
   *  any state that is not a pause. */
  team: 'a' | 'b' | null;
  /** Seconds a pause may last before the plugin unpauses, 0 for no ceiling. */
  limit: number;
  /** A pause the plugin called itself while waiting for a dropped player. */
  leave: boolean;
  /** Rostered players who have not readied, during a ready-up. Empty
   *  otherwise, and empty once everyone has and the countdown is running. */
  unready: string[];
}

export type LogEvent =
  | { kind: 'match_start'; token: string; map: string }
  | { kind: 'map_result'; token: string; map: string; a: number; b: number }
  // `phase` rides on the heartbeat so a lost PHASE datagram self-corrects
  // within thirty seconds. Absent (not null) from an older plugin, so the
  // event is byte-for-byte what it was before phases existed.
  | { kind: 'heartbeat'; token: string; phase?: Phase }
  // What the game is doing right now, from the plugin's one-second tracker.
  // Emitted on every transition. Cosmetic: nothing here is read back when a
  // result is computed, but the pause records built from it are what an admin
  // sees when a team complains about the other side's pausing.
  | { kind: 'phase'; token: string; phase: Phase }
  | { kind: 'leave'; token: string; steamid: string; remaining: number }
  | { kind: 'return'; token: string; steamid: string; remaining: number }
  | { kind: 'abandon'; token: string; steamid: string }
  | { kind: 'problem'; token: string; code: string }
  | { kind: 'player'; token: string; steamid: string; event: 'connect' | 'disconnect' }
  | { kind: 'match_end'; token: string; a: number; b: number; winner: 'a' | 'b' | 'draw' }
  // Emitted by !load_4v4p for a match started in-game rather than by us. The
  // three arrive as a burst: one MATCH_CREATE, one MATCH_ROSTER per player,
  // then MATCH_CREATE_END. UDP is lossy and unordered, so the consumer must
  // treat players as a set it accumulates and MATCH_CREATE_END as the signal
  // that it should have `players` of them, not as a guarantee that it does.
  | { kind: 'match_create'; token: string; map: string; players: number }
  // joinedMap: the map ordinal the player was rostered on; 0 for the starting
  // eight, later for a sub or late joiner rostered at a go-live (plugin
  // RosterLateJoiners). Absent on older plugins, read as 0.
  | { kind: 'match_roster'; token: string; steamid: string; team: 'a' | 'b'; name: string; joinedMap: number }
  | { kind: 'match_create_end'; token: string; players: number }
  // Per-player counters for the spectator view, emitted every 10s while live.
  // Cosmetic: the identical counters are pulled authoritatively over rcon at
  // the end, so these are never read back when a result is computed.
  | { kind: 'live_stat'; token: string; steamid: string; stats: Record<string, number> }
  // One half of one map. Emitted at OnRoundIsLive and again at round_end.
  // The END value of `surv` is authoritative: the plugin's orientation
  // mapping is unreliable early in a round, which is exactly why that
  // reconciliation logic exists at all.
  //
  // round_start's `surv` is NULL when the plugin could not yet tell which pug
  // team holds survivor. The plugin used to guess "a" in that case on the
  // reasoning that ROUND_END would correct it, but ROUND_END is one UDP
  // datagram with no retransmit: losing it left a fabricated side recorded as
  // reliable. An absent field is the honest signal, and the round is stored
  // unreliable until ROUND_END supplies the real one.
  | { kind: 'round_start'; token: string; map: string; half: number; surv: 'a' | 'b' | null }
  // `map` rides along so recordRoundEnd can resolve the round to the map it
  // actually belongs to rather than to whatever had finished by arrival time.
  // `alive` is how many survivors were still standing when the round ended,
  // which is what survival rate is computed from. Null means the reading was
  // absent or malformed, NOT that nobody survived: zero is a real, and the
  // most interesting, value. Optional for the same reason `map` is, an older
  // plugin does not send it.
  | { kind: 'round_end'; token: string; map: string | null; half: number; surv: 'a' | 'b'; score: number; alive: number | null }
  // One discrete thing that happened, for the live feed. Generic on purpose:
  // the plugin decides the `kind` and the page renders per kind, so a new
  // event type needs no backend change. `seq` is per-match monotonic and makes
  // a duplicated datagram an upsert over itself rather than a double count.
  | {
      kind: 'live_event'; token: string; seq: number; event: string;
      actor: string; target: string | null; value: number;
      // -1 when the plugin predates round timing. Distinct from 0, which is
      // a real event in the first millisecond of a round.
      half: number; tMs: number;
    }
  // In-game chat. Its own line type rather than an EVENT because EVENT's
  // fields are kind/actor/target/an integer value, and a message is free text.
  //
  // `seq` is the SAME counter EVENT uses, not a second one. One monotonic
  // sequence across both streams is what lets a viewer interleave a message
  // and a death in the order they really happened, and it reuses the dedupe
  // key that already exists.
  //
  // Unlike an event, chat is NOT gated on stats being active: the gate exists
  // to stop counters moving between rounds and during ready-up, which are
  // exactly the moments chat is most worth having. `tMs` is -1 then, the same
  // sentinel RoundMs() already returns.
  | {
      kind: 'chat'; token: string; seq: number; half: number; tMs: number;
      steamid: string; team: 'a' | 'b' | null; message: string;
    }
  // The two lines below carry NO token, so neither has a `token` field and
  // neither can pass the listener's token gate. LogListener admits them only
  // from a game server's own address. Both can only ever produce a hint.
  //
  // From l4d_consistency.smx: a human who connected, never entered the game
  // and left by their own hand on a map that forced files. That is what a
  // file-consistency rejection looks like from the server, and also what a
  // cancelled loading screen looks like. `secs` is -1 when the plugin could
  // not read the connection time.
  | { kind: 'signon_drop'; steamid: string; secs: number; forced: number; name: string }
  // The engine's own `"name<uid><STEAM_1:Y:Z><>" entered the game` line.
  | { kind: 'entered'; steamid: string }
  // Where a client connected from, emitted for EVERY human that joins the box
  // whether or not a match is being tracked and whether or not they are on a
  // roster: an account nobody expected is exactly the one worth correlating.
  // Token-less, so LogListener admits it on the sender's address alone. The
  // address is used to compute a hash and is never stored; see
  // src/playerNetworks.ts. `country` is absent when the GeoIP extension is
  // not loaded, which is normal and not an error.
  | { kind: 'player_net'; steamid: string; ip: string; country: string | null };

/** Parse `key=val key=val` pairs from the remainder of a PUG line. */
/** The phase fields shared by PHASE and HEARTBEAT. Plugin team numbers are
 *  1 and 2 for pug a and b; anything else is nobody. An unknown state is
 *  null rather than stored: the page renders a fixed set of words. */
function phaseOf(state: string | undefined, rest: Record<string, string>): Phase | null {
  if (!state || !(PHASE_STATES as readonly string[]).includes(state)) return null;
  const team = rest.team === '1' ? 'a' : rest.team === '2' ? 'b' : null;
  const limit = intOf(rest.limit) ?? 0;
  const unready = (rest.unready ?? '').split(',').filter((id) => /^\d{17}$/.test(id));
  return { state: state as PhaseState, team, limit: limit < 0 ? 0 : limit, leave: rest.leave === '1', unready };
}

function kv(parts: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq > 0) out[p.slice(0, eq)] = p.slice(eq + 1);
  }
  return out;
}

function intOf(s: string | undefined): number | null {
  if (s === undefined || !/^-?\d+$/.test(s)) return null;
  return Number(s);
}

function teamOf(s: string | undefined): 'a' | 'b' | null {
  return s === 'a' || s === 'b' ? s : null;
}

function halfOf(s: string | undefined): number | null {
  const n = intOf(s);
  return n === 1 || n === 2 ? n : null;
}

/** The engine's `L MM/DD/YYYY - HH:MM:SS: ` stamp, which opens every log line. */
const LOG_STAMP_RE = /L \d{2}\/\d{2}\/\d{4} - \d{2}:\d{2}:\d{2}: /;

/** Anchored at BOTH ends, and the name is greedy, so the fields read are the
 *  last `<uid><steamid><team>` on the line: the engine's own. A name that
 *  contains a whole fake suffix only ends up inside the name group. A `say`
 *  line cannot match either, because it ends with a closing quote. */
const ENTERED_RE = /^".*<\d+><(STEAM_\d:[01]:\d{1,10})><[^<>"]*>" entered the game$/;

/**
 * The token-less lines: `L4DC SIGNON_DROP ...` from l4d_consistency.smx and the
 * engine's "entered the game". Returns undefined when the line is neither, so
 * the caller carries on to the PUG grammar; null when it is one of ours but
 * malformed.
 *
 * Unlike the PUG path, the marker is NOT searched for anywhere in the datagram.
 * Those lines are protected by a secret token; these are protected only by the
 * sender's address, and the game server's address also sends every chat line
 * (`"name<2><STEAM_1:0:5><Survivor>" say "L4DC SIGNON_DROP steamid=..."`). So
 * the marker must be the first thing after the engine's stamp, which no player
 * controlled text can be: every engine line about a player opens with a quote.
 */
function parseSourcePinned(text: string): LogEvent | null | undefined {
  const stamp = LOG_STAMP_RE.exec(text);
  const body = (stamp ? text.slice(stamp.index + stamp[0].length) : text).split('\n', 1)[0].trimEnd();

  if (body.startsWith('L4DC ')) {
    // Name is last and takes the rest of the line. Every other field is read
    // from the slice BEFORE the first ` name=`, the CHAT treatment, so a name
    // like "x steamid=76561198000000009" cannot overwrite the real steamid.
    const at = body.indexOf(' name=');
    if (at < 0) return null;
    const head = body.slice(0, at).split(/\s+/);
    if (head[1] !== 'SIGNON_DROP') return null;
    const rest = kv(head.slice(2));
    const steamid = steamId64Of(rest.steamid ?? '');
    const secs = intOf(rest.secs);
    const forced = intOf(rest.forced);
    const name = body.slice(at + ' name='.length).trim().slice(0, 64);
    if (!steamid || secs === null || secs < -1 || forced === null || forced < 1 || !name) return null;
    return { kind: 'signon_drop', steamid, secs, forced, name };
  }

  // Where a client connected from. Same protection as SIGNON_DROP and for the
  // same reason: no token, so the marker must be the first thing after the
  // engine's stamp, which no player-controlled text can be.
  if (body.startsWith('PUGNET ')) {
    const rest = kv(body.slice('PUGNET '.length).split(/\s+/));
    const steamid = steamId64Of(rest.steamid ?? '');
    const ip = rest.ip ?? '';
    // Shape-checked here rather than downstream: this value decides whether a
    // sighting counts and what its hash is.
    if (!steamid || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return null;
    const cc = (rest.cc ?? '').toUpperCase();
    return { kind: 'player_net', steamid, ip, country: /^[A-Z]{2}$/.test(cc) ? cc : null };
  }

  const entered = ENTERED_RE.exec(body);
  if (entered) {
    const steamid = steamId64Of(entered[1]);
    return steamid ? { kind: 'entered', steamid } : null;
  }
  return undefined;
}

/**
 * Decode a raw srcds log UDP datagram into a typed PUG event, or null if it is
 * not one of ours or is malformed. Never throws. Tolerant of the engine framing
 * being present or absent. It locates the `PUG ` marker rather than assuming an
 * offset.
 */
export function parseLogDatagram(buf: Buffer): LogEvent | null {
  const text = buf.toString('utf8');
  const pinned = parseSourcePinned(text);
  if (pinned !== undefined) return pinned;
  const idx = text.indexOf('PUG ');
  if (idx < 0) return null;
  const line = text.slice(idx).split('\n', 1)[0].trim();
  const parts = line.split(/\s+/);
  if (parts.length < 3) return null;
  const token = parts[1];
  if (!TOKEN_RE.test(token)) return null;
  const verb = parts[2];
  const rest = kv(parts.slice(3));

  switch (verb) {
    case 'MATCH_START': {
      if (!rest.map) return null;
      return { kind: 'match_start', token, map: rest.map };
    }
    case 'MAP_RESULT': {
      const a = intOf(rest.a), b = intOf(rest.b);
      if (!rest.map || a === null || b === null) return null;
      return { kind: 'map_result', token, map: rest.map, a, b };
    }
    case 'HEARTBEAT': {
      if (rest.phase === undefined) return { kind: 'heartbeat', token };
      const phase = phaseOf(rest.phase, rest);
      // A heartbeat is a liveness signal first: a phase word this parser
      // does not know costs the phase, never the heartbeat.
      return phase ? { kind: 'heartbeat', token, phase } : { kind: 'heartbeat', token };
    }
    case 'PHASE': {
      const phase = phaseOf(rest.state, rest);
      return phase ? { kind: 'phase', token, phase } : null;
    }
    case 'LEAVE':
    case 'RETURN': {
      const remaining = intOf(rest.remaining);
      if (!/^\d{17}$/.test(rest.steamid ?? '') || remaining === null) return null;
      return { kind: verb === 'LEAVE' ? 'leave' : 'return', token, steamid: rest.steamid, remaining };
    }
    case 'ABANDON':
      if (!/^\d{17}$/.test(rest.steamid ?? '')) return null;
      return { kind: 'abandon', token, steamid: rest.steamid };
    case 'PROBLEM':
      // A short machine code, never free text: kv() splits on whitespace and
      // the backend owns the wording (matchTeardown.ts problemText).
      if (!/^[a-z_]{1,40}$/.test(rest.code ?? '')) return null;
      return { kind: 'problem', token, code: rest.code };
    case 'PLAYER': {
      if (!/^\d{17}$/.test(rest.steamid ?? '')) return null;
      if (rest.event !== 'connect' && rest.event !== 'disconnect') return null;
      return { kind: 'player', token, steamid: rest.steamid, event: rest.event };
    }
    case 'MATCH_CREATE': {
      const players = intOf(rest.players);
      if (!rest.map || players === null || players < 1) return null;
      return { kind: 'match_create', token, map: rest.map, players };
    }
    case 'MATCH_ROSTER': {
      if (!/^\d{17}$/.test(rest.steamid ?? '')) return null;
      if (rest.team !== 'a' && rest.team !== 'b') return null;
      // The name is taken from the raw line rather than from kv(), because
      // in-game names contain spaces and may contain '=' too. The plugin emits
      // name= last on the line for exactly this reason, so everything after the
      // first `name=` is the name.
      const at = line.indexOf(' name=');
      if (at < 0) return null;
      const name = line.slice(at + ' name='.length).trim();
      if (!name) return null;
      const joinedMap = Math.max(0, intOf(rest.joined_map) ?? 0);
      return { kind: 'match_roster', token, steamid: rest.steamid, team: rest.team, name, joinedMap };
    }
    case 'MATCH_CREATE_END': {
      const players = intOf(rest.players);
      if (players === null || players < 1) return null;
      return { kind: 'match_create_end', token, players };
    }
    case 'LIVESTAT': {
      if (!/^\d{17}$/.test(rest.steamid ?? '')) return null;
      const stats: Record<string, number> = {};
      for (const [k, v] of Object.entries(rest)) {
        if (k === 'steamid') continue;
        const n = intOf(v);
        // Skip rather than reject: the plugin omits skill_detect keys entirely
        // when it is not loaded, and a future key we do not know about must not
        // invalidate the whole line.
        if (n !== null) stats[k] = n;
      }
      if (Object.keys(stats).length === 0) return null;
      return { kind: 'live_stat', token, steamid: rest.steamid, stats };
    }
    case 'ROUND_START': {
      const half = halfOf(rest.half);
      // An ABSENT surv= is accepted: the plugin omits it rather than guessing
      // when the orientation mapping has not settled. A PRESENT but malformed
      // one is still rejected, because that is a corrupt line, not an
      // admission of not knowing.
      if (rest.surv !== undefined && teamOf(rest.surv) === null) return null;
      const surv = teamOf(rest.surv);
      if (!rest.map || half === null) return null;
      return { kind: 'round_start', token, map: rest.map, half, surv };
    }
    case 'ROUND_END': {
      const half = halfOf(rest.half);
      const surv = teamOf(rest.surv);
      const score = intOf(rest.score);
      if (half === null || surv === null || score === null) return null;
      // Optional: a staged older plugin does not send it, and the ordinal
      // falls back to the map count in that case.
      //
      // alive is optional on the same grounds, but is deliberately NOT
      // allowed to fail the line: the side and score are what the match
      // record is built from, and losing a whole round to a corrupt survival
      // reading would be a bad trade. intOf returns null for both absent and
      // malformed, and null here reads downstream as "not measured".
      // A negative survivor count is not a thing the plugin can legitimately
      // report (CountAliveSurvivors counts upward from zero), so treat one as
      // a corrupt reading rather than storing nonsense that would later be
      // averaged into a survival rate.
      const aliveRaw = intOf(rest.alive);
      const alive = aliveRaw !== null && aliveRaw >= 0 ? aliveRaw : null;
      return { kind: 'round_end', token, map: rest.map ?? null, half, surv, score, alive };
    }
    case 'EVENT': {
      const seq = intOf(rest.seq);
      const value = intOf(rest.value);
      if (seq === null || seq < 1 || value === null) return null;
      if (!rest.kind || !/^[a-z_]{1,24}$/.test(rest.kind)) return null;
      if (!/^\d{17}$/.test(rest.actor ?? '')) return null;
      // target is "0" when the event has no second party.
      const target = /^\d{17}$/.test(rest.target ?? '') ? rest.target : null;
      // Optional so a staged older plugin still produces usable events.
      const half = halfOf(rest.half) ?? -1;
      const tMs = intOf(rest.t) ?? -1;
      return { kind: 'live_event', token, seq, event: rest.kind, actor: rest.actor, target, value, half, tMs };
    }
    case 'CHAT': {
      // The message is taken from the raw line rather than from kv(), because
      // chat contains spaces and very often contains '='. The plugin emits
      // msg= last on the line for exactly this reason, so everything after the
      // first ' msg=' is the message. Same treatment as MATCH_ROSTER's name=,
      // and for the same reason: tokenizing would let a message forge any
      // field that followed it.
      const at = line.indexOf(' msg=');
      if (at < 0) return null;
      const message = line.slice(at + ' msg='.length);
      if (!message) return null;
      // Deliberately SHADOWS the outer `rest`, which was built by
      // kv()-tokenizing the WHOLE remainder of the line, including everything
      // inside the message. A message like "gg steamid=76561198000000009
      // team=a" would otherwise overwrite the real steamid and team with ones
      // forged inside the chat text. Naming this `rest` rather than something
      // like `head` makes the contaminated outer binding unreachable by name
      // for the rest of this block, so a later edit cannot accidentally read
      // a field off it: the compiler always resolves `rest` here to the safe,
      // pre-`msg=` one.
      const rest = kv(line.slice(0, at).split(/\s+/).slice(3));
      const seq = intOf(rest.seq);
      if (seq === null || seq < 1) return null;
      if (!/^\d{17}$/.test(rest.steamid ?? '')) return null;
      // half and t are optional so a staged older plugin still parses.
      const half = halfOf(rest.half) ?? -1;
      const tMs = intOf(rest.t) ?? -1;
      return {
        kind: 'chat', token, seq, half, tMs,
        steamid: rest.steamid, team: teamOf(rest.team), message,
      };
    }
    case 'MATCH_END': {
      const a = intOf(rest.a), b = intOf(rest.b);
      if (a === null || b === null) return null;
      if (rest.winner !== 'a' && rest.winner !== 'b' && rest.winner !== 'draw') return null;
      return { kind: 'match_end', token, a, b, winner: rest.winner };
    }
    default:
      return null;
  }
}
