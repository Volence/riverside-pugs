import { serverPasswordFor } from './matchToken.js';
import type { DB } from './db.js';
import { Queue, QUEUE_SIZE } from './queue.js';
import { Lobby, realScheduler, type Scheduler, type LobbySnapshot, type LobbyPhase, type PersistedLobby } from './lobby.js';
import { balanceTeams, type RatedPlayer } from './balance.js';
import { averageSiDamage, chooseTeams, isHoldout, logBalance, statBalanceConfig, statLines, type StatBalanceDecision, type StatLine } from './statBalance.js';
import { balanceMu } from './newcomerPrior.js';
import { duoBonusMu } from './duoBonus.js';
import { getRatings, getPlayer, currentSeasonId } from './players.js';
import { getSetting, getJsonSetting } from './settings.js';
import { getServer } from './serverPool.js';
import { campaignRegistry, downloadMarks } from './campaignRegistry.js';
import { ballotMode, createBallot, finishBallot, hasBallot } from './ballot.js';
import { spectateFor, type SpectateInfo } from './spectate.js';
import { activeTimeout, recordPenalty, timeoutCause, type PenaltyKind } from './penalties.js';
import { QUEUE_BLOCK_MESSAGE, type QueueBlock } from './queueGate.js';
import { READY_BLOCK_MESSAGE, type ReadyBlock } from './readyGate.js';
import type { Orchestrator } from './orchestrator.js';
import { inGoodStanding } from './standing.js';
import { abortNoticeFor, type AbortNotice } from './matchAborts.js';
import { recordQueueStint } from './queueActivity.js';
import { DUO_REQUEUE_NOT_BOTH, requeueOptIns, wantsRequeue, type RequeueResult } from './matchRequeue.js';
import { seasonOneLive } from './seasonThemes.js';
import {
  duoQueueLive, partnerOf, pairsAmong, createDuoInvite, acceptDuoInvite, declineDuoInvite,
  cancelDuoInvite, endDuo as endDuoRow, getDuoInvite, openDuoInvites, recordDuoPopSkips, recordDuoHoldBump, type DuoResult,
} from './duos.js';

export interface MatchmakerDeps {
  broadcast: (event: string) => void;
  orchestrator: Orchestrator;
  scheduler?: Scheduler;
  rng?: () => number;
  /** Optional out-of-band notification hook (Discord). Must never throw. */
  notify?: (msg: string) => void;
  /** The Discord requirement (linked + in the server). See queueGate.ts. */
  queueGate?: (steamid: string) => QueueBlock | null;
  /** The voice requirement for pressing Ready. See readyGate.ts. */
  readyGate?: (steamid: string) => ReadyBlock | null;
  /** The clock for the held-pop limit (duo_hold_max_minutes). Epoch ms. */
  now?: () => number;
}

/** How often a held pop is looked at again while it waits, so a change to
 *  duo_hold_max_minutes applies within this long even if nobody joins. */
export const HOLD_RECHECK_MS = 60 * 1000;

/** Parse discord_queue_thresholds defensively. A malformed or non-array
 *  setting (admin typo, hand-edited sqlite row) must never break join(). */
export function safeThresholds(raw: string | undefined): number[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export interface NamedPlayer {
  steamid: string;
  name: string;
  avatar: string | null;
}

export const DUO_OFF = 'duo queue is not on right now';

export interface DuoView {
  partner: NamedPlayer | null;
  incoming: { id: number; from: NamedPlayer }[];
  outgoing: { id: number; to: NamedPlayer } | null;
}

export interface StateSnapshot {
  queue: { count: number; joined: boolean; players: NamedPlayer[]; sideOptIn: boolean; duos: [string, string][] };
  lobby:
    | (Omit<LobbySnapshot, 'players'> & {
      /** Each player's own ready block, so the roster can show who is
       *  still missing from voice. Null once they may press Ready. */
      players: (NamedPlayer & { readyBlock: ReadyBlock | null })[];
      myVote: string | null;
      /** Slot ballots only: options needing a download this viewer has
       *  probably not got (never finished a match that used it). A mark,
       *  never a restriction. */
      downloads?: string[];
    })
    | null;
  match: {
    id: number;
    state: string;
    campaign: string;
    teamA: NamedPlayer[];
    teamB: NamedPlayer[];
    /** Only for a viewer on this roster, and only once the match is live. */
    connect: { host: string; port: number; password: string } | null;
    /** How to watch this match on SourceTV, or null. */
    spectate: SpectateInfo | null;
    /** True while the match is configuring and no server has been claimed
     *  yet, so it is queued behind another match. Never true once the match
     *  is live. */
    waitingForServer: boolean;
    /** Whether the viewer has asked to queue again when this match ends
     *  (src/matchRequeue.ts); null where that is not on offer (not live yet,
     *  or not a queue PUG). */
    requeue: boolean | null;
  } | null;
  /** A queue timeout the viewer is serving, as an ISO time. */
  timeout: { until: string; offenses: number; kind: PenaltyKind } | null;
  /** What the viewer still has to do on Discord before they may queue. */
  queueBlock: QueueBlock | null;
  /** What the viewer still has to do before they may press Ready. */
  readyBlock: ReadyBlock | null;
  /**
   * The ready check the viewer was just in, if it failed and they have not
   * dismissed it yet.
   *
   * The failure used to be edited onto the lobby card in #queue-here, which
   * is how the people in it found out. That card is now deleted and the
   * detail goes to the admin channel instead, so without this the eight
   * people it happened to would see the pop simply vanish.
   */
  lobbyNotice: {
    notReady: NamedPlayer[];
    youWereReady: boolean;
    /** Set instead when nobody failed to ready: this player was taken out of
     *  the lobby (banned mid ready check) and the pop was cancelled for it. */
    removed?: NamedPlayer;
    /** Set instead when staff cancelled the pop outright (cancelLobby). */
    cancelled?: true;
    /** Set when the viewer's duo partner did not come back to the queue with them, so neither did they. */
    duoMissed?: NamedPlayer;
    /** Set when the viewer asked to queue again after a match and their duo
     *  partner did not, so neither was requeued (requeueOne). */
    duoNoRequeue?: NamedPlayer;
  } | null;
  /**
   * The match the viewer was on, if it was aborted and they have not
   * dismissed the notice. Persisted (src/matchAborts.ts), unlike lobbyNotice:
   * an aborted match can have cost them a timeout, and a reload must not be
   * the way they lose the only explanation.
   */
  abortNotice: AbortNotice | null;
  /** The viewer's duo and open invites; null while the duo queue is off (before Season 1, or switched off). */
  duo: DuoView | null;
}

/** Lifecycle events the broadcast cannot carry, because it sends only an
 *  event name. The bot needs them to tie a lobby's message to the match it
 *  became, and penalties need who failed a ready check. Every method optional. */
export interface MatchmakerListener {
  lobbyStarted?(lobbyId: string, players: string[]): void;
  lobbyCompleted?(lobbyId: string, matchId: number): void;
  lobbyFailed?(lobbyId: string, ready: string[], notReady: string[]): void;
  /** Anything changed (queue, lobbies, opt-ins). Fired after the state is saved. */
  stateChanged?(): void;
}

/** Distinguishes this process's lobby ids from a previous run's, so a stored
 *  Discord message for lob_1 before a restart is never mistaken for lob_1 after. */
const BOOT = Date.now().toString(36);
let instanceSeq = 0;

export class Matchmaker {
  private queue: Queue;
  private lobbyMap = new Map<string, Lobby>();
  private playerLobby = new Map<string, string>();
  private lobbySeq = 0;
  private readonly idPrefix = `lob_${BOOT}${(instanceSeq++).toString(36)}_`;
  private listeners: MatchmakerListener[] = [];
  private failures = new Map<string, { ready: string[]; notReady: string[] }>();
  /** Per-player "your ready check failed", keyed by steamid. In memory and
   *  deliberately not persisted: it is about something that happened seconds
   *  ago, and a notice that outlived a restart would be noise. */
  private notices = new Map<string, { notReady: string[]; youWereReady: boolean; removed?: string; cancelled?: true; duoMissed?: string; duoNoRequeue?: string }>();
  /** Queued players who asked for side games (2v2/3v3 while waiting). Kept
   *  through a pop so a failed ready check resumes the game; see sideGames.ts. */
  private sideOptIn = new Set<string>();
  /** When the queue became held (a duo that does not fit behind 7 solos, so
   *  9+ queued and nothing popping), epoch ms; null while it is not held.
   *  Saved with the queue, so a restart keeps the clock running. */
  private holdSince: number | null = null;
  private holdTimer: number | null = null;

  constructor(private db: DB, private deps: MatchmakerDeps) {
    // Built here rather than as a field initializer so `db` is certainly
    // assigned before the hook can use it.
    this.queue = new Queue({ onStintEnd: (stint) => recordQueueStint(db, stint) });
  }

  /**
   * Save the queue and open lobbies, then tell every surface.
   *
   * Both live only in memory, so a deploy used to drop the queue and cancel a
   * ready check in progress. Written on every change (a handful of rows' worth
   * of JSON, a few times a minute at most), and read back by restore() at boot.
   */
  private changed(): void {
    try {
      const state = {
        queue: this.queue.list(),
        queueJoinedAt: this.queue.joinTimes(),
        queueRequeued: this.queue.requeuedIds(),
        lobbies: [...this.lobbyMap.values()]
          .map((l) => l.persist())
          .filter((l) => l.phase === 'ready_check' || l.phase === 'map_vote'),
        sideOptIn: [...this.sideOptIn],
        holdSince: this.holdSince,
      };
      this.db.prepare(
        `INSERT INTO matchmaker_state (id, json, updated_at) VALUES (1, ?, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
      ).run(JSON.stringify(state));
    } catch (err) {
      console.error('[matchmaker] could not save queue state:', err);
    }
    this.deps.broadcast('refresh');
    this.emit('stateChanged');
  }

  /** Bring back the queue and lobbies saved by the previous process. Call once
   *  at boot, before any surface starts reading state. */
  restore(): void {
    const row = this.db.prepare('SELECT json FROM matchmaker_state WHERE id = 1').get() as { json: string } | undefined;
    if (!row) return;
    let state: { queue: string[]; queueJoinedAt?: Record<string, number>; queueRequeued?: string[]; lobbies: PersistedLobby[]; sideOptIn?: string[]; holdSince?: number | null };
    try {
      state = JSON.parse(row.json);
    } catch {
      return;
    }
    for (const p of state.lobbies ?? []) {
      const lobby = Lobby.restore(p, this.lobbyOpts(), this.lobbyEvents(p.id), this.deps.scheduler ?? realScheduler);
      this.lobbyMap.set(p.id, lobby);
      for (const player of p.players) this.playerLobby.set(player, p.id);
    }
    for (const id of state.queue ?? []) {
      if (!this.playerLobby.has(id)) this.queue.join(id, state.queueJoinedAt?.[id], state.queueRequeued?.includes(id) ?? false);
    }
    for (const id of state.sideOptIn ?? []) {
      if (this.queue.has(id) || this.playerLobby.has(id)) this.sideOptIn.add(id);
    }
    // A held queue restores held, its clock where it was (downtime counts),
    // and the re-check timer picks it up from here.
    this.holdSince = typeof state.holdSince === 'number' ? state.holdSince : null;
    this.trackHold();
    if (state.queue?.length || state.lobbies?.length) {
      console.log(`[matchmaker] restored ${state.queue?.length ?? 0} queued and ${state.lobbies?.length ?? 0} lobbies`);
    }
    this.changed();
  }

  private lobbyOpts() {
    return {
      readySeconds: Number(getSetting(this.db, 'ready_seconds') ?? 120),
      voteSeconds: Number(getSetting(this.db, 'vote_seconds') ?? 30),
      // A practice map is never a vote option, even if the saved pool still
      // names it: the practice-only switch prunes the pool, this is the backstop.
      mapPool: getJsonSetting<string[]>(this.db, 'map_pool')
        .filter((slug) => campaignRegistry(this.db).get(slug)?.practiceOnly !== true),
      rng: this.deps.rng,
    };
  }

  private lobbyEvents(id: string) {
    return {
      onEvent: () => this.changed(),
      onComplete: (result: { players: string[]; campaign: string }) => this.onLobbyComplete(id, result),
      onFail: (ready: string[], notReady: string[]) => this.onLobbyFail(id, ready, notReady),
    };
  }

  on(listener: MatchmakerListener): void {
    this.listeners.push(listener);
  }

  private emit<K extends keyof MatchmakerListener>(
    event: K, ...args: Parameters<NonNullable<MatchmakerListener[K]>>
  ): void {
    for (const l of this.listeners) {
      try {
        (l[event] as ((...a: unknown[]) => void) | undefined)?.(...args);
      } catch (err) {
        console.error(`[matchmaker] listener ${event} failed:`, err);
      }
    }
  }

  /** Every open lobby, for surfaces that render all of them (the bot). */
  lobbies(): { id: string; snapshot: LobbySnapshot }[] {
    return [...this.lobbyMap.values()].map((l) => ({ id: l.id, snapshot: l.snapshot() }));
  }

  /** The pops in progress, named, for the admin Live desk's Cancel pop. */
  adminLobbies(): { id: string; phase: LobbyPhase; deadline: number; players: (NamedPlayer & { ready: boolean })[] }[] {
    return [...this.lobbyMap.values()]
      .map((l) => l.snapshot())
      .filter((s) => s.phase === 'ready_check' || s.phase === 'map_vote')
      .map((s) => ({
        id: s.id, phase: s.phase, deadline: s.deadline,
        players: s.players.map((p) => ({ ...this.named(p), ready: s.ready.includes(p) })),
      }));
  }

  /** Who readied and who did not, for a lobby that failed in this process. */
  lastFailure(lobbyId: string): { ready: string[]; notReady: string[] } | null {
    return this.failures.get(lobbyId) ?? null;
  }

  /** The viewer has read their failed-ready-check notice. */
  dismissNotice(steamid: string): void {
    this.notices.delete(steamid);
  }

  join(steamid: string): { ok: boolean; error?: string } {
    const own = this.joinBlock(steamid);
    if (own) return { ok: false, error: own };
    // A duo queues together or not at all.
    const partner = this.partner(steamid);
    if (partner) {
      const theirs = this.partnerBlock(partner);
      if (theirs) return { ok: false, error: theirs };
    }
    // Queueing again is moving on: the notice is about the pop they just
    // lost, and holding it over the next one would be wrong.
    this.notices.delete(steamid);
    this.queue.join(steamid);
    if (partner) {
      // placePair queues the partner straight behind the joiner (or moves an
      // already queued partner there), so the pair sits together at the back.
      this.notices.delete(partner);
      this.queue.placePair(steamid, partner);
    }
    const thresholds = safeThresholds(getSetting(this.db, 'discord_queue_thresholds'));
    if (thresholds.includes(this.queue.count())) {
      this.deps.notify?.(`🧟 ${this.queue.count()}/${QUEUE_SIZE} in queue`);
    }
    this.maybeStartLobby();
    this.changed();
    return { ok: true };
  }

  leave(steamid: string): void {
    const partner = this.partner(steamid);
    for (const id of partner ? [steamid, partner] : [steamid]) {
      this.queue.leave(id);
      this.sideOptIn.delete(id);
    }
    // A held pop (a duo behind 7 solos) can become poppable when someone
    // ahead leaves: 6 solos + the duo is a full 8.
    this.maybeStartLobby();
    this.changed();
  }

  /** Staff take a player out of the queue. A duo still goes as a pair (one
   *  left behind would queue half a duo), and the partner is told why. */
  staffRemoveFromQueue(steamid: string): void {
    const partner = this.partner(steamid);
    if (partner && this.queue.has(partner)) {
      const n = this.notices.get(partner);
      this.notices.set(partner, { notReady: n?.notReady ?? [], youWereReady: n?.youWereReady ?? true, ...n, duoMissed: steamid });
    }
    this.leave(steamid);
  }

  /**
   * Take a player out of matchmaking altogether: the queue, and any ready
   * check or campaign vote they are in. For a ban. leave() only ever knew
   * about the queue, so someone banned during a ready check stayed in it,
   * could still ready up, and was handed a place on the match.
   *
   * There is no "decline" in a lobby to borrow; the one way a lobby ends
   * without a match is a failed ready check, so this follows that path
   * (onLobbyFail): dissolve, put the others back at the FRONT of the queue in
   * their old order, and pop again at once if the queue behind them can fill
   * the gap. Two differences: nobody is penalised, because nobody here failed
   * to ready, and no failure is recorded, so the Discord card closes as
   * cancelled rather than naming people who did nothing wrong.
   */
  remove(steamid: string): void {
    // A removed player's duo ends, idle or not; the partner carries on as a solo.
    const endedDuo = this.partner(steamid) !== null && endDuoRow(this.db, steamid, 'system').ok;
    const lobbyId = this.playerLobby.get(steamid);
    if (!lobbyId && !this.queue.has(steamid)) {
      // Idle, but the partner's page still shows the duo.
      if (endedDuo) this.changed();
      return;
    }
    this.sideOptIn.delete(steamid);
    this.queue.leave(steamid);
    if (lobbyId) {
      const others = this.dissolveLobby(lobbyId).filter((p) => p !== steamid);
      for (const p of others) this.notices.set(p, { notReady: [], youWereReady: true, removed: steamid });
      this.emit('lobbyFailed', lobbyId, [...others], []);
      this.queue.requeueFront(others);
    }
    // Also for a queued player: their leaving can free a held pop.
    this.maybeStartLobby();
    this.changed();
  }

  /**
   * Staff cancel a pop at whatever phase it is in, ready check or campaign
   * vote. Before this the only way to stop one was to wait for it to become a
   * match and abort that: a player who had to be banned slipped into a full
   * lobby, and staff sat through the ready check and the vote before they
   * could do anything (owner, 2026-09-29).
   *
   * The same path remove() takes, for the whole lobby: dissolve it, put the
   * players back at the FRONT of the queue in their old order, and pop again
   * if the queue can fill one. `exclude` are players NOT to requeue (the one
   * being removed). Nobody is penalised and no failure is recorded, so the
   * Discord card closes as cancelled. With no id the only open lobby is
   * meant; with two open and no id this refuses rather than guess.
   */
  cancelLobby(lobbyId?: string, exclude: string[] = []):
    { ok: true; lobbyId: string; requeued: string[]; excluded: string[] } | { ok: false; error: string } {
    const open = [...this.lobbyMap.values()].filter((l) => {
      const phase = l.snapshot().phase;
      return phase === 'ready_check' || phase === 'map_vote';
    });
    const lobby = lobbyId ? open.find((l) => l.id === lobbyId) : open.length === 1 ? open[0] : undefined;
    if (!lobby) {
      return { ok: false, error: lobbyId || open.length === 0 ? 'no such pop is running' : 'more than one pop is running; name one' };
    }
    const players = this.dissolveLobby(lobby.id);
    const skip = new Set(exclude);
    const back = players.filter((p) => !skip.has(p));
    const excluded = players.filter((p) => skip.has(p));
    for (const p of excluded) this.sideOptIn.delete(p);
    for (const p of back) this.notices.set(p, { notReady: [], youWereReady: true, cancelled: true });
    this.emit('lobbyFailed', lobby.id, [...back], []);
    const kept = this.keepPairs(back);
    this.queue.requeueFront(kept);
    this.maybeStartLobby();
    this.changed();
    return { ok: true, lobbyId: lobby.id, requeued: kept, excluded };
  }

  /**
   * Put the blameless players of an aborted match back at the FRONT of the
   * queue, the way a failed ready check puts back the ones who readied
   * (src/matchAborts.ts). Only those who may queue right now: in good
   * standing (no ban), no queue timeout, the Discord requirement met, and not
   * already queued, in a pop or on another open match. The ready-time voice
   * rule is not a queue rule and is left to the ready check, as for anyone.
   * Returns who went back.
   */
  requeueAfterAbort(steamids: string[]): string[] {
    const back = steamids.filter((id) =>
      !this.queue.has(id) && !this.playerLobby.has(id) && !this.hasOpenMatch(id)
      && inGoodStanding(this.db, id)
      && !this.deps.queueGate?.(id)
      && !activeTimeout(this.db, id));
    const kept = this.keepPairs(back);
    if (kept.length === 0) return [];
    this.queue.requeueFront(kept);
    this.maybeStartLobby();
    this.changed();
    return kept;
  }

  /**
   * Queue again everyone who asked for it on this just-completed match (!rq
   * or the site toggle, src/matchRequeue.ts). An ordinary join, at the back,
   * through every rule join() checks; what each one came to goes into their
   * end-of-match note.
   */
  requeueAfterMatch(matchId: number): Map<string, RequeueResult> {
    const out = new Map<string, RequeueResult>();
    for (const id of requeueOptIns(this.db, matchId)) out.set(id, this.requeueOne(id, matchId));
    return out;
  }

  /** One player's requeue, for the match end and for a !rq that arrives
   *  just after it. Already queued (or in a pop) counts as done.
   *
   *  A duo goes back only when both asked on this match (owner 2026-11-02):
   *  one partner's !rq does not queue the other. A partner who cannot queue
   *  at all (a timeout) is still the reason given, as for any join; a banned
   *  partner's duo has already ended, so the one who asked goes back solo. */
  requeueOne(steamid: string, matchId: number): RequeueResult {
    if (this.queue.has(steamid) || this.playerLobby.has(steamid)) return { ok: true };
    const partner = this.partner(steamid);
    if (partner && !wantsRequeue(this.db, matchId, partner)) {
      const theirs = this.partnerBlock(partner);
      if (theirs) return { ok: false, error: theirs };
      const n = this.notices.get(steamid);
      this.notices.set(steamid, { notReady: n?.notReady ?? [], youWereReady: n?.youWereReady ?? true, ...n, duoNoRequeue: partner });
      this.changed();
      return { ok: false, error: DUO_REQUEUE_NOT_BOTH };
    }
    const r = this.join(steamid);
    return r.ok ? { ok: true } : { ok: false, error: r.error ?? 'could not join the queue' };
  }

  inviteDuo(fromId: string, toId: string, source: 'site' | 'discord'): { ok: true; inviteId: number } | { ok: false; error: string } {
    if (!duoQueueLive(this.db)) return { ok: false, error: DUO_OFF };
    const r = createDuoInvite(this.db, fromId, toId, source);
    if (r.ok) this.changed();
    return r;
  }

  /** Accept a duo invite. If either is queued the pair is seated at the
   *  later spot, so the other must be able to queue right now. */
  acceptDuo(inviteId: number, steamid: string): DuoResult {
    if (!duoQueueLive(this.db)) return { ok: false, error: DUO_OFF };
    const inv = getDuoInvite(this.db, inviteId);
    if (!inv || inv.toId !== steamid) return { ok: false, error: 'that invite is no longer open' };
    const pair = [inv.fromId, inv.toId];
    // Banned or held: no duo, whether or not either is queued.
    for (const id of pair) {
      if (!inGoodStanding(this.db, id)) return { ok: false, error: `${this.named(id).name} cannot duo right now` };
    }
    for (const id of pair) {
      if (this.playerLobby.has(id) || this.hasOpenMatch(id)) {
        return { ok: false, error: `${this.named(id).name} is in a ready check or a match; try again after it` };
      }
    }
    const queued = pair.some((id) => this.queue.has(id));
    if (queued) {
      for (const id of pair) {
        if (this.queue.has(id)) continue;
        const b = this.joinBlock(id);
        if (b) return { ok: false, error: `${this.named(id).name} cannot queue: ${b}` };
      }
    }
    const r = acceptDuoInvite(this.db, inviteId, steamid);
    if (!r.ok) return r;
    if (queued) {
      this.queue.placePair(inv.fromId, inv.toId);
      this.maybeStartLobby();
    }
    this.changed();
    return { ok: true };
  }

  declineDuo(inviteId: number, steamid: string): DuoResult {
    const r = declineDuoInvite(this.db, inviteId, steamid);
    if (r.ok) this.changed();
    return r;
  }

  cancelDuo(inviteId: number, steamid: string): DuoResult {
    const r = cancelDuoInvite(this.db, inviteId, steamid);
    if (r.ok) this.changed();
    return r;
  }

  /** End the viewer's duo. Both stay where they are, as solos. */
  endDuo(steamid: string): DuoResult {
    const r = endDuoRow(this.db, steamid, steamid);
    if (!r.ok) return r;
    // A held duo that splits into two solos can fill the pop it was holding.
    this.maybeStartLobby();
    this.changed();
    return r;
  }

  ready(steamid: string): { ok: boolean; error?: string } {
    const lobby = this.lobbyFor(steamid);
    if (!lobby) return { ok: false, error: 'no ready check active' };
    const block = this.readyBlock(steamid);
    if (block) return { ok: false, error: READY_BLOCK_MESSAGE[block] };
    return lobby.markReady(steamid) ? { ok: true } : { ok: false, error: 'no ready check active' };
  }

  /** Take back a player's Ready, for someone who left voice during the ready
   *  check. True when it changed anything. */
  unready(steamid: string): boolean {
    return this.lobbyFor(steamid)?.unmarkReady(steamid) ?? false;
  }

  /** What stands between this player and pressing Ready, or null. */
  readyBlock(steamid: string): ReadyBlock | null {
    return this.deps.readyGate?.(steamid) ?? null;
  }

  vote(steamid: string, campaign: string): boolean {
    return this.lobbyFor(steamid)?.castVote(steamid, campaign) ?? false;
  }

  setSideOptIn(steamid: string, on: boolean): { ok: boolean; error?: string } {
    if (!this.queue.has(steamid)) return { ok: false, error: 'join the queue first' };
    if (on) this.sideOptIn.add(steamid); else this.sideOptIn.delete(steamid);
    this.changed();
    return { ok: true };
  }

  isSideOptedIn(steamid: string): boolean {
    return this.sideOptIn.has(steamid);
  }

  /** Queued players who opted in, in queue order. Lobby members are not
   *  queued, so this is empty for them while a pop is running. */
  sideCandidates(): string[] {
    return this.queue.list().filter((id) => this.sideOptIn.has(id));
  }

  queuePosition(steamid: string): number {
    return this.queue.list().indexOf(steamid);
  }

  lobbyOf(steamid: string): LobbySnapshot | null {
    return this.lobbyFor(steamid)?.snapshot() ?? null;
  }

  /** All players currently in any lobby (dev tooling). */
  lobbyMembers(): string[] {
    return [...this.playerLobby.keys()];
  }

  /** Everyone waiting for a match right now: in the queue, or in a lobby that
   *  has not gone live yet. Read by the streams page to decide whether a live
   *  stream belongs in the top tier. Both collections live only in memory, so
   *  this is the only way out of the matchmaker. */
  engagedIds(): string[] {
    return [...new Set([...this.queue.list(), ...this.lobbyMembers()])];
  }

  private lobbyFor(steamid: string): Lobby | undefined {
    const id = this.playerLobby.get(steamid);
    return id ? this.lobbyMap.get(id) : undefined;
  }

  private hasOpenMatch(steamid: string): boolean {
    return this.db
      .prepare(
        `SELECT 1 FROM matches m JOIN match_players mp ON mp.match_id = m.id
         WHERE mp.player_id = ? AND m.state IN ('configuring','live') LIMIT 1`,
      )
      .get(steamid) !== undefined;
  }

  /** The viewer's duo partner while duos are on, else null: with the switch
   *  off every duo queues as two solos. */
  private partner(steamid: string): string | null {
    return duoQueueLive(this.db) ? partnerOf(this.db, steamid) : null;
  }

  private queuedPairs(): [string, string][] {
    return pairsAmong(this.queue.list(), (id) => this.partner(id));
  }

  /** Why this player may not queue right now, or null. join()'s own rules,
   *  shared so a duo can check both members before queueing either. */
  private joinBlock(steamid: string): string | null {
    if (this.playerLobby.has(steamid)) return 'already in a lobby';
    if (this.hasOpenMatch(steamid)) return 'already in an active match';
    const block = this.deps.queueGate?.(steamid) ?? null;
    if (block) return QUEUE_BLOCK_MESSAGE[block];
    const timeout = activeTimeout(this.db, steamid);
    if (timeout) return `timed out for ${timeoutCause(timeout.kind)} until ${timeout.until.toISOString()}`;
    return null;
  }

  /** Why this player's duo partner may not queue right now, as join() words
   *  it, or null. The joiner's own standing is the caller's check
   *  (requireActive); the partner's is ours, or a banned or held partner
   *  would ride along. */
  private partnerBlock(partner: string): string | null {
    const theirs = inGoodStanding(this.db, partner) ? this.joinBlock(partner) : 'not an active player';
    return theirs ? `your duo partner ${this.named(partner).name} cannot queue: ${theirs}` : null;
  }

  /** Drop anyone whose duo partner is neither going back with them nor
   *  already queued: a duo never queues half. Each one dropped is told why. */
  private keepPairs(ids: string[]): string[] {
    const coming = new Set(ids);
    return ids.filter((id) => {
      const p = this.partner(id);
      if (!p || coming.has(p) || this.queue.has(p)) return true;
      const n = this.notices.get(id);
      this.notices.set(id, { notReady: n?.notReady ?? [], youWereReady: n?.youWereReady ?? true, ...n, duoMissed: p });
      // Out of the queue, so out of side games, as for anyone who leaves.
      this.sideOptIn.delete(id);
      return false;
    });
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** duo_hold_max_minutes, 0 (never force a held pop) when unset or bad. */
  private holdMaxMs(): number {
    const m = Number(getSetting(this.db, 'duo_hold_max_minutes') ?? 0);
    return Number.isFinite(m) && m > 0 ? m * 60 * 1000 : 0;
  }

  /** Whether a held pop has waited past duo_hold_max_minutes and may be
   *  forced through. Off (0) by default: never bump a solo. */
  private holdExpired(): boolean {
    const max = this.holdMaxMs();
    return max > 0 && this.holdSince !== null && this.queue.count() > QUEUE_SIZE
      && this.now() - this.holdSince >= max;
  }

  /** Start or stop the hold clock to match the queue, and keep one re-check
   *  timer armed while it is held, since nothing else may happen to re-run
   *  the pop check. */
  private trackHold(): void {
    // maybeStartLobby only stops with 8+ queued when nothing could pop.
    const held = this.queue.count() >= QUEUE_SIZE;
    const sched = this.deps.scheduler ?? realScheduler;
    if (this.holdTimer !== null) {
      sched.clear(this.holdTimer);
      this.holdTimer = null;
    }
    if (!held) {
      this.holdSince = null;
      return;
    }
    this.holdSince ??= this.now();
    const max = this.holdMaxMs();
    const due = max > 0 ? Math.max(0, this.holdSince + max - this.now()) : HOLD_RECHECK_MS;
    this.holdTimer = sched.set(() => {
      this.holdTimer = null;
      const before = this.lobbyMap.size;
      this.maybeStartLobby();
      if (this.lobbyMap.size !== before) this.changed();
    }, Math.min(due, HOLD_RECHECK_MS));
  }

  private maybeStartLobby(): void {
    while (this.queue.count() >= QUEUE_SIZE) {
      const partnerOf = (id: string) => this.partner(id);
      let players = this.queue.takeBatch(QUEUE_SIZE, partnerOf);
      // Enough people, but only a duo is left for the last slot: wait for
      // one more player rather than bump someone who queued first, unless
      // staff set a limit on that wait (duo_hold_max_minutes) and it is up.
      if (players.length === 0) {
        if (!this.holdExpired()) break;
        const heldMs = this.now() - this.holdSince!;
        const forced = this.queue.takeBatchBumping(QUEUE_SIZE, partnerOf);
        if (forced.taken.length === 0) break;
        players = forced.taken;
        this.holdSince = null;
        try {
          recordDuoHoldBump(this.db, forced.bumped, heldMs);
        } catch (err) {
          console.error('[matchmaker] could not record a forced duo pop:', err);
        }
      }
      // Review data only: never let it stop a pop.
      try {
        recordDuoPopSkips(this.db, this.queue.lastSkippedDuos);
      } catch (err) {
        console.error('[matchmaker] could not record duo pop skips:', err);
      }
      const id = `${this.idPrefix}${++this.lobbySeq}`;
      const opts = this.lobbyOpts();
      // The four-slot ballot (src/ballot.ts) narrows the options for this
      // lobby; persist() keeps them across a restart. A failed draw falls
      // back to the whole pool rather than stop a pop.
      if (ballotMode(this.db) === 'slots') {
        try {
          opts.mapPool = createBallot(this.db, id, opts.mapPool, this.deps.rng ?? Math.random);
        } catch (err) {
          console.error(`[matchmaker] could not draw a ballot for ${id}, offering the whole pool:`, err);
        }
      }
      const lobby = new Lobby(id, players, opts, this.lobbyEvents(id), this.deps.scheduler ?? realScheduler);
      this.lobbyMap.set(id, lobby);
      this.deps.notify?.('🔔 Queue popped, ready check started!');
      for (const p of players) this.playerLobby.set(p, id);
      this.emit('lobbyStarted', id, [...players]);
    }
    this.trackHold();
  }

  private dissolveLobby(id: string): string[] {
    const lobby = this.lobbyMap.get(id);
    if (!lobby) return [];
    lobby.destroy();
    this.lobbyMap.delete(id);
    for (const p of lobby.players) this.playerLobby.delete(p);
    return lobby.players;
  }

  private onLobbyFail(id: string, ready: string[], notReady: string[] = []): void {
    try {
      // Bounded: only the most recent failures matter, to the message that
      // renders them within seconds.
      this.failures.set(id, { ready: [...ready], notReady: [...notReady] });
      if (this.failures.size > 20) this.failures.delete(this.failures.keys().next().value!);
      for (const p of notReady) recordPenalty(this.db, p, 'ready_fail', null);
      // Everyone who was in it, on both sides of the reason.
      for (const p of [...ready, ...notReady]) {
        this.notices.set(p, { notReady: [...notReady], youWereReady: ready.includes(p) });
      }
      this.emit('lobbyFailed', id, [...ready], [...notReady]);
      this.dissolveLobby(id);
      for (const p of notReady) this.sideOptIn.delete(p);
      this.queue.requeueFront(this.keepPairs(ready));
      this.maybeStartLobby();
    } catch (err) {
      console.error(`lobby ${id} fail handler error:`, err);
    } finally {
      this.changed();
    }
  }

  private onLobbyComplete(id: string, result: { players: string[]; campaign: string }): void {
    try {
      // Read before dissolving: the tally the ballot record keeps.
      const votes = this.lobbyMap.get(id)?.snapshot().votes ?? {};
      this.dissolveLobby(id);
      for (const p of result.players) this.sideOptIn.delete(p);
      const ratings = getRatings(this.db, result.players);
      // A first-time player is balanced as weaker than their starting rating
      // when newcomer_balance_offset is set (see newcomerPrior.ts); the stored
      // rating is never changed.
      const mus = balanceMu(this.db, ratings);
      // Duos share a team and count as stronger than their ratings by a
      // bonus that grows with how high they are rated (src/duoBonus.ts).
      const groups = pairsAmong(result.players, (p) => this.partner(p));
      const bonus = new Map<string, { partner: string; mu: number }>();
      for (const [x, y] of groups) {
        const b = duoBonusMu(this.db, x, y);
        bonus.set(x, { partner: y, mu: b });
        bonus.set(y, { partner: x, mu: b });
      }
      const rated: RatedPlayer[] = result.players.map((steamid) => {
        const r = ratings.get(steamid)!;
        return { steamid, mu: (mus.get(steamid) ?? r.mu) + (bonus.get(steamid)?.mu ?? 0), sigma: r.sigma };
      });
      // Stat-aware tie-break (src/statBalance.ts). The rating-best split is
      // computed first, exactly as before; with balance_stats_enabled off it
      // is what plays. Any failure in the stat side falls back to it, so a
      // bad stat query can never stop a pop. The teams are picked once the
      // match row exists, because the holdout is decided by match id.
      let statIn: { cfg: ReturnType<typeof statBalanceConfig>; avg: number; lines: Map<string, StatLine> } | null = null;
      try {
        const cfg = statBalanceConfig(this.db);
        const avg = averageSiDamage(this.db);
        statIn = { cfg, avg, lines: statLines(this.db, result.players, avg) };
      } catch (err) {
        console.error('[matchmaker] stat balance inputs failed, using the rating split:', err);
      }
      let decision: StatBalanceDecision | null = null;
      const season = currentSeasonId(this.db);
      const matchId = this.db.transaction(() => {
        const insertMatch = this.db.prepare(
          "INSERT INTO matches (season_id, state, campaign, origin) VALUES (?, 'configuring', ?, 'queue')",
        );
        const id = Number(insertMatch.run(season, result.campaign).lastInsertRowid);
        let teamA: string[];
        let teamB: string[];
        try {
          if (!statIn) throw new Error('no stat inputs');
          decision = chooseTeams(rated, new Map([...statIn.lines].map(([p, l]) => [p, l.s])), statIn.cfg,
            { groups, holdout: isHoldout(id, statIn.cfg) });
          ({ teamA, teamB } = decision.chosen);
        } catch (err) {
          if (statIn) console.error('[matchmaker] stat balance failed, using the rating split:', err);
          ({ teamA, teamB } = balanceTeams(rated, { groups }));
        }
        const insertMp = this.db.prepare(
          'INSERT INTO match_players (match_id, player_id, team, duo_partner, duo_bonus) VALUES (?, ?, ?, ?, ?)',
        );
        const ins = (p: string, team: 'a' | 'b') =>
          insertMp.run(id, p, team, bonus.get(p)?.partner ?? null, bonus.get(p)?.mu ?? null);
        for (const p of teamA) ins(p, 'a');
        for (const p of teamB) ins(p, 'b');
        return id;
      })();
      const statLog = statIn && decision ? { ...statIn, decision: decision as StatBalanceDecision } : null;

      // Review data and the next ballot's bumps; never blocks the match.
      try {
        finishBallot(this.db, id, votes, result.campaign, matchId);
      } catch (err) {
        console.error(`[matchmaker] could not record the ballot for match ${matchId}:`, err);
      }

      if (statLog) {
        // Every queue match is logged, on or off; a failed write never
        // blocks the match that was just made.
        try {
          const { cfg, avg, lines, decision } = statLog;
          logBalance(this.db, matchId, cfg, avg, decision, rated.map((p) => {
            const r = ratings.get(p.steamid)!;
            const l = lines.get(p.steamid)!;
            return {
              steamid: p.steamid, mu: r.mu, sigma: r.sigma, balanceMu: p.mu,
              games: l.games, rawPerGame: l.rawPerGame, shrunkPerGame: l.shrunkPerGame, s: l.s,
            };
          }));
        } catch (err) {
          console.error(`[matchmaker] could not log balance for match ${matchId}:`, err);
        }
      }

      this.emit('lobbyCompleted', id, matchId);
      // 'refresh' again once setup settles, live or not: the connect block in
      // /api/state appears when the match goes live, and browsers no longer
      // refetch on the spectator feed's 'live' (web/src/hooks/useLiveState.ts).
      this.deps.orchestrator.setupMatch(matchId).catch((err) => {
        console.error(`orchestrator failed for match ${matchId}:`, err);
      }).finally(() => this.deps.broadcast('refresh'));
    } catch (err) {
      console.error(`lobby ${id} complete handler error:`, err);
    } finally {
      this.changed();
    }
  }

  stateFor(steamid: string): StateSnapshot {
    const named = this.named.bind(this);

    const lobby = this.lobbyFor(steamid);
    const snap = lobby?.snapshot();

    // The JOIN on match_players below is what puts the viewer on the roster:
    // no separate roster check is needed (or wanted) anywhere in this method.
    const matchRow = this.db
      .prepare(
        `SELECT m.* FROM matches m
         JOIN match_players mp ON mp.match_id = m.id
         WHERE mp.player_id = ? AND m.state IN ('configuring','live')
         ORDER BY m.id DESC LIMIT 1`,
      )
      .get(steamid) as
      | { id: number; state: string; campaign: string; server_id: number | null; token: string | null; kind: string; booking_id: number | null }
      | undefined;

    let match: StateSnapshot['match'] = null;
    if (matchRow) {
      const mps = this.db
        .prepare('SELECT player_id, team FROM match_players WHERE match_id = ?')
        .all(matchRow.id) as { player_id: string; team: 'a' | 'b' }[];

      // Derived, never stored twice: this is the same expression setupMatch
      // uses to set sv_password, so the two cannot drift.
      let connect: { host: string; port: number; password: string } | null = null;
      if (matchRow.state === 'live' && matchRow.server_id !== null && matchRow.token) {
        const server = getServer(this.db, matchRow.server_id);
        if (server) {
          connect = {
            host: server.host,
            port: server.port,
            password: serverPasswordFor(matchRow.token),
          };
        }
      }

      match = {
        id: matchRow.id,
        state: matchRow.state,
        campaign: matchRow.campaign,
        teamA: mps.filter((r) => r.team === 'a').map((r) => named(r.player_id)),
        teamB: mps.filter((r) => r.team === 'b').map((r) => named(r.player_id)),
        connect,
        spectate: spectateFor(this.db, matchRow.server_id),
        waitingForServer: matchRow.state === 'configuring' && matchRow.server_id === null,
        requeue: matchRow.state === 'live' && matchRow.kind === 'pug' && matchRow.booking_id === null && seasonOneLive(this.db)
          ? wantsRequeue(this.db, matchRow.id, steamid) : null,
      };
    }

    return {
      queue: {
        count: this.queue.count(),
        joined: this.queue.has(steamid),
        players: this.queue.list().map(named),
        sideOptIn: this.sideOptIn.has(steamid),
        duos: this.queuedPairs(),
      },
      lobby: snap && lobby
        ? {
          ...snap,
          players: snap.players.map((p) => ({ ...named(p), readyBlock: this.readyBlock(p) })),
          myVote: lobby.myVote(steamid),
          // Only on a slot ballot, so the 'all' vote's snapshot is unchanged.
          ...(hasBallot(this.db, lobby.id) ? { downloads: downloadMarks(this.db, steamid, snap.options) } : {}),
        }
        : null,
      match,
      timeout: (() => {
        const t = activeTimeout(this.db, steamid);
        return t ? { until: t.until.toISOString(), offenses: t.offenses, kind: t.kind } : null;
      })(),
      queueBlock: this.deps.queueGate?.(steamid) ?? null,
      readyBlock: this.readyBlock(steamid),
      lobbyNotice: (() => {
        const n = this.notices.get(steamid);
        if (!n) return null;
        return {
          notReady: n.notReady.map(named), youWereReady: n.youWereReady,
          ...(n.removed ? { removed: named(n.removed) } : {}),
          ...(n.cancelled ? { cancelled: true as const } : {}),
          ...(n.duoMissed ? { duoMissed: named(n.duoMissed) } : {}),
          ...(n.duoNoRequeue ? { duoNoRequeue: named(n.duoNoRequeue) } : {}),
        };
      })(),
      abortNotice: abortNoticeFor(this.db, steamid),
      duo: (() => {
        if (!duoQueueLive(this.db)) return null;
        const p = partnerOf(this.db, steamid);
        const inv = openDuoInvites(this.db, steamid);
        return {
          partner: p ? named(p) : null,
          incoming: inv.incoming.map((i) => ({ id: i.id, from: named(i.fromId) })),
          outgoing: inv.outgoing ? { id: inv.outgoing.id, to: named(inv.outgoing.toId) } : null,
        };
      })(),
    };
  }

  /**
   * The queue as anyone may see it, signed in or not.
   *
   * Deliberately not stateFor with the auth removed: that snapshot is entirely
   * viewer-relative (are YOU queued, YOUR lobby, YOUR vote) and would be
   * meaningless anonymously. Carries no connect block and no match id.
   */
  publicQueue(): { count: number; players: NamedPlayer[]; phase: LobbyPhase | null; duos: [string, string][] } {
    const anyLobby = [...this.lobbyMap.values()][0];
    return {
      count: this.queue.count(),
      players: this.queue.list().map((id) => this.named(id)),
      phase: anyLobby?.snapshot().phase ?? null,
      duos: this.queuedPairs(),
    };
  }

  private named(id: string): NamedPlayer {
    const p = getPlayer(this.db, id);
    return { steamid: id, name: p?.name ?? id, avatar: p?.avatar ?? null };
  }
}
