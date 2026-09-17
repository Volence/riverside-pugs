import type { DB } from '../db.js';
import type { Matchmaker } from '../matchmaker.js';
import type { Hub } from '../ws.js';
import { QUEUE_SIZE } from '../queue.js';
import { CAMPAIGNS } from '../campaigns.js';
import { displaySr } from '../rating.js';
import { currentSeasonId } from '../players.js';
import {
  getMessage, messagesInState, rekeyMessage, saveMessage, setMessageState,
} from './messageStore.js';
import {
  renderCancelled, renderLobby, renderLobbyFailed, renderMatch, renderPanel, renderResult,
  type MatchCardState, type PlayerView, type ResultPlayer,
} from './presenter.js';
import type { BotTransport, MessagePayload } from './transport.js';

/** Team voice channels, plugged in by voice.ts. Kept as a narrow hook so this
 *  file does not depend on how channels are made. */
export interface VoiceHook {
  /** Create channels for a match that has teams, if not already done. */
  ensure(matchId: number): Promise<void>;
  /** Channel ids for a match's card, or null. */
  channelsFor(matchId: number): { teamAId: string; teamBId: string } | null;
  /** Delete channels of finished matches when due. */
  sweep(): Promise<void>;
}

export interface DiscordSyncDeps {
  db: DB;
  matchmaker: Matchmaker;
  hub: Hub;
  transport: BotTransport;
  publicUrl: string;
  channelId: string;
  voice?: VoiceHook;
  now?: () => number;
  /** Off in tests that drive pass() by hand. */
  autoSchedule?: boolean;
  debounceMs?: number;
  intervalMs?: number;
}

interface MatchRow {
  id: number;
  state: string;
  campaign: string;
  server_id: number | null;
  winner: 'a' | 'b' | 'draw' | null;
  team_a_score: number;
  team_b_score: number;
}

/**
 * Keeps the bot's messages in #queue-here in step with the site.
 *
 * Driven by the same hub broadcast the browsers get (debounced), plus a slow
 * interval as a backstop for state changes that do not broadcast (the reapers).
 * Each pass re-renders everything and edits only messages whose payload changed.
 *
 * The queue panel is kept as the channel's last message: whenever a pass posts
 * anything new, the panel is deleted and posted again below it.
 */
export class DiscordSync {
  private hashes = new Map<string, string>();
  private unsubscribe: (() => void) | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private interval: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private dirty = false;
  /** Matches born from a lobby whose card was never posted (the whole lobby
   *  ran between two passes). The next pass posts their card. */
  private needCard = new Set<number>();

  constructor(private deps: DiscordSyncDeps) {}

  async start(): Promise<void> {
    const { db } = this.deps;
    // A lobby card whose lobby was not restored belongs to a process that is
    // gone. Restored lobbies (Matchmaker.restore) keep their card.
    const restored = new Set(this.deps.matchmaker.lobbies().map((l) => l.id));
    for (const m of messagesInState(db, 'match', 'open')) {
      if (!m.ref.startsWith('lob_') || restored.has(m.ref)) continue;
      await this.safeEdit(m.channel_id, m.message_id, renderCancelled());
      setMessageState(db, 'match', m.ref, 'cancelled');
    }

    this.deps.matchmaker.on({
      // Synchronous, so by the time any pass runs the card is already keyed by
      // the match it became.
      lobbyCompleted: (lobbyId, matchId) => {
        if (getMessage(db, 'match', lobbyId)) rekeyMessage(db, 'match', lobbyId, String(matchId));
        else this.needCard.add(matchId);
      },
    });

    if (this.deps.autoSchedule !== false) {
      this.unsubscribe = this.deps.hub.subscribe(() => this.schedule());
      this.deps.matchmaker.on({ lobbyStarted: () => this.schedule(), lobbyFailed: () => this.schedule() });
      this.interval = setInterval(() => this.schedule(), this.deps.intervalMs ?? 15_000);
    }
    await this.pass();
  }

  stop(): void {
    this.unsubscribe?.();
    if (this.debounce) clearTimeout(this.debounce);
    if (this.interval) clearInterval(this.interval);
  }

  schedule(): void {
    if (this.debounce) return;
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.pass();
    }, this.deps.debounceMs ?? 1000);
  }

  /** One full render. Serialised: a pass requested while one runs is folded
   *  into a single follow-up pass. */
  async pass(): Promise<void> {
    if (this.running) {
      this.dirty = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.dirty = false;
        try {
          await this.passOnce();
        } catch (err) {
          console.error('[discord] sync pass failed:', err);
        }
      } while (this.dirty);
    })();
    try {
      await this.running;
    } finally {
      this.running = null;
    }
  }

  private async passOnce(): Promise<void> {
    const { db, matchmaker: mm, channelId } = this.deps;
    let posted = false;

    // 1. Open lobbies.
    const lobbies = mm.lobbies();
    for (const { id, snapshot } of lobbies) {
      if (snapshot.phase !== 'ready_check' && snapshot.phase !== 'map_vote') continue;
      const payload = renderLobby({
        lobbyId: id,
        phase: snapshot.phase,
        deadlineMs: snapshot.deadline,
        players: snapshot.players.map((p) => ({ ...this.player(p), ready: snapshot.ready.includes(p) })),
        options: snapshot.options.map((c) => ({ campaign: c, name: CAMPAIGNS[c]?.name ?? c, votes: snapshot.votes[c] ?? 0 })),
      });
      // A pass awaits Discord between lobbies, and a lobby can complete in
      // that gap. Posting a card for it then would orphan a second card, since
      // the completion already re-keyed (or queued) the real one.
      if (!getMessage(db, 'match', id) && !mm.lobbies().some((l) => l.id === id)) continue;
      if (await this.upsert('match', id, payload)) posted = true;
    }

    // 2. Lobby cards whose lobby is gone and did not become a match.
    const live = new Set(lobbies.map((l) => l.id));
    for (const m of messagesInState(db, 'match', 'open')) {
      if (!m.ref.startsWith('lob_') || live.has(m.ref)) continue;
      const failure = mm.lastFailure(m.ref);
      const payload = failure
        ? renderLobbyFailed({ ready: failure.ready.map((p) => this.player(p)), notReady: failure.notReady.map((p) => this.player(p)) })
        : renderCancelled();
      await this.safeEdit(m.channel_id, m.message_id, payload);
      setMessageState(db, 'match', m.ref, failure ? 'failed' : 'cancelled');
    }

    // 3. Match cards. A match that never had a lobby card gets one posted
    // first, with the roster pinged, since nobody saw the pop.
    for (const matchId of [...this.needCard]) {
      this.needCard.delete(matchId);
      if (getMessage(db, 'match', String(matchId))) continue;
      const { teamA, teamB } = this.roster(matchId);
      const ids = [...teamA, ...teamB].map((p) => this.player(p).discordId).filter((x): x is string => !!x);
      await this.post('match', String(matchId), {
        content: ids.map((id) => `<@${id}>`).join(' ') || undefined,
        embeds: [{ title: `Riverside PUG #${matchId}`, description: 'Teams are set.' }],
        components: [],
        mentionUserIds: ids,
      });
      posted = true;
    }
    for (const m of messagesInState(db, 'match', 'open')) {
      if (m.ref.startsWith('lob_')) continue;
      const matchId = Number(m.ref);
      const row = db.prepare(
        'SELECT id, state, campaign, server_id, winner, team_a_score, team_b_score FROM matches WHERE id = ?',
      ).get(matchId) as MatchRow | undefined;
      if (!row) {
        setMessageState(db, 'match', m.ref, 'done');
        continue;
      }
      if (this.deps.voice && (row.state === 'configuring' || row.state === 'live')) {
        await this.deps.voice.ensure(matchId).catch((err) => console.error('[discord] voice ensure failed:', err));
      }
      const { teamA, teamB } = this.roster(matchId);
      const state: MatchCardState = row.state === 'completed' ? 'finished'
        : row.state === 'aborted' ? 'aborted'
          : row.state === 'live' ? 'live'
            : row.server_id === null ? 'waiting' : 'configuring';
      const payload = renderMatch({
        matchId,
        campaignName: CAMPAIGNS[row.campaign]?.name ?? row.campaign,
        publicUrl: this.deps.publicUrl,
        state,
        teamA: teamA.map((p) => this.player(p)),
        teamB: teamB.map((p) => this.player(p)),
        voice: this.deps.voice?.channelsFor(matchId) ?? null,
        unlinked: [...teamA, ...teamB].map((p) => this.player(p)).filter((p) => !p.discordId).map((p) => p.name),
      });
      await this.upsert('match', m.ref, payload);

      if (state === 'live' && !getMessage(db, 'live', m.ref)) {
        const players = [...teamA, ...teamB].map((p) => this.player(p));
        const ids = players.filter((p) => p.discordId).map((p) => p.discordId!);
        const ping: MessagePayload = {
          content: `${ids.map((id) => `<@${id}>`).join(' ')}\nPUG #${matchId}: the server is ready. Press **Connect** on the match card above.`.trim(),
          embeds: [],
          components: [[{ kind: 'button', customId: `m:${matchId}:connect`, label: 'Connect', style: 'success' }]],
          mentionUserIds: ids,
        };
        const messageId = await this.deps.transport.send(channelId, ping);
        saveMessage(db, { kind: 'live', ref: m.ref, channelId, messageId, state: 'done' });
        posted = true;
      }

      if (state === 'finished' && row.winner) {
        if (!getMessage(db, 'result', m.ref)) {
          const messageId = await this.deps.transport.send(channelId, renderResult({
            matchId,
            campaignName: CAMPAIGNS[row.campaign]?.name ?? row.campaign,
            publicUrl: this.deps.publicUrl,
            scoreA: row.team_a_score,
            scoreB: row.team_b_score,
            winner: row.winner,
            teamA: teamA.map((p) => this.resultPlayer(p, matchId)),
            teamB: teamB.map((p) => this.resultPlayer(p, matchId)),
          }));
          saveMessage(db, { kind: 'result', ref: m.ref, channelId, messageId, state: 'done' });
          posted = true;
        }
        setMessageState(db, 'match', m.ref, 'done');
      } else if (state === 'aborted') {
        setMessageState(db, 'match', m.ref, 'done');
      }
    }

    if (this.deps.voice) await this.deps.voice.sweep().catch((err) => console.error('[discord] voice sweep failed:', err));

    // 4. The panel, kept last in the channel.
    const q = mm.publicQueue();
    const panel = renderPanel({
      publicUrl: this.deps.publicUrl,
      size: QUEUE_SIZE,
      players: q.players.map((p) => this.player(p.steamid)),
      phase: q.phase,
    });
    const stored = getMessage(db, 'panel', 'queue');
    if (stored && posted) {
      await this.deps.transport.remove(stored.channel_id, stored.message_id).catch(() => {});
      this.hashes.delete(stored.message_id);
      await this.post('panel', 'queue', panel);
    } else {
      await this.upsert('panel', 'queue', panel);
    }
  }

  /** Send when there is no stored message, edit when the payload changed,
   *  re-send when the stored message was deleted. True when a new message was
   *  posted. */
  private async upsert(kind: string, ref: string, payload: MessagePayload): Promise<boolean> {
    const stored = getMessage(this.deps.db, kind, ref);
    if (!stored) {
      await this.post(kind, ref, payload);
      return true;
    }
    const hash = JSON.stringify(payload);
    if (this.hashes.get(stored.message_id) === hash) return false;
    // An edit never pings, whatever the content says, so it is always safe to
    // re-render a card that names players.
    const ok = await this.safeEdit(stored.channel_id, stored.message_id, { ...payload, mentionUserIds: [] });
    if (ok) {
      this.hashes.set(stored.message_id, hash);
      return false;
    }
    await this.post(kind, ref, payload, stored.state);
    return true;
  }

  private async post(kind: string, ref: string, payload: MessagePayload, state = 'open'): Promise<void> {
    const messageId = await this.deps.transport.send(this.deps.channelId, payload);
    saveMessage(this.deps.db, { kind, ref, channelId: this.deps.channelId, messageId, state });
    this.hashes.set(messageId, JSON.stringify(payload));
  }

  private async safeEdit(channelId: string, messageId: string, payload: MessagePayload): Promise<boolean> {
    try {
      return await this.deps.transport.edit(channelId, messageId, payload);
    } catch (err) {
      console.error('[discord] edit failed:', err);
      return true; // transient: keep the message, retry on a later pass
    }
  }

  private roster(matchId: number): { teamA: string[]; teamB: string[] } {
    const rows = this.deps.db.prepare('SELECT player_id, team FROM match_players WHERE match_id = ? ORDER BY rowid')
      .all(matchId) as { player_id: string; team: 'a' | 'b' }[];
    return {
      teamA: rows.filter((r) => r.team === 'a').map((r) => r.player_id),
      teamB: rows.filter((r) => r.team === 'b').map((r) => r.player_id),
    };
  }

  private player(steamid: string): PlayerView {
    const { db } = this.deps;
    const p = db.prepare('SELECT name, discord_id FROM players WHERE steamid = ?').get(steamid) as
      | { name: string; discord_id: string | null } | undefined;
    const r = db.prepare('SELECT mu, sigma FROM player_ratings WHERE player_id = ? AND season_id = ?')
      .get(steamid, currentSeasonId(db)) as { mu: number; sigma: number } | undefined;
    return { name: p?.name ?? steamid, discordId: p?.discord_id ?? null, sr: r ? displaySr(r.mu, r.sigma) : null };
  }

  private resultPlayer(steamid: string, matchId: number): ResultPlayer {
    const h = this.deps.db.prepare(
      'SELECT mu_before, sigma_before, mu_after, sigma_after FROM rating_history WHERE match_id = ? AND player_id = ?',
    ).get(matchId, steamid) as { mu_before: number; sigma_before: number; mu_after: number; sigma_after: number } | undefined;
    const base = this.player(steamid);
    return {
      ...base,
      sr: null,
      srBefore: h ? displaySr(h.mu_before, h.sigma_before) : null,
      srAfter: h ? displaySr(h.mu_after, h.sigma_after) : null,
    };
  }
}
