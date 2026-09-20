import type { DB } from '../db.js';
import type { Matchmaker } from '../matchmaker.js';
import type { Hub } from '../ws.js';
import { QUEUE_SIZE } from '../queue.js';
import { campaignDisplayName } from '../campaignRegistry.js';
import { displaySr } from '../rating.js';
import { spectateFor } from '../spectate.js';
import { currentSeasonId } from '../players.js';
import {
  getMessage, messagesInState, rekeyMessage, saveMessage, setMessageState,
} from './messageStore.js';
import {
  renderCancelled, renderLobby, renderLobbyFailed, renderMatch, renderPanel, renderQueueAlert,
  renderResult, type MatchCardState, type PlayerView, type ResultPlayer,
} from './presenter.js';
import { getSetting } from '../settings.js';
import { safeThresholds } from '../matchmaker.js';

/** Shortest gap between two queue alerts.
 *
 *  Not about rate limits. One filling queue can cross two thresholds a minute
 *  apart, and two pings for the same fill is what teaches people to mute the
 *  channel. The higher threshold is the more useful one, so it wins and the
 *  lower is dropped rather than queued. */
const ALERT_COOLDOWN_MS = 10 * 60 * 1000;
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
  /** The highest threshold already announced for the CURRENT filling of the
   *  queue, reset when it empties out again. Without it, one person leaving and
   *  rejoining at 6/8 re-announces every time, which is how a useful ping
   *  becomes a muted channel. */
  private announced = 0;
  /** When the last alert went out, for the cooldown. */
  private lastAlertMs = 0;

  constructor(private deps: DiscordSyncDeps) {}

  async start(): Promise<void> {
    const { db } = this.deps;
    // A lobby card whose lobby was not restored belongs to a process that is
    // gone. Restored lobbies (Matchmaker.restore) keep their card.
    const restored = new Set(this.deps.matchmaker.lobbies().map((l) => l.id));
    for (const m of messagesInState(db, 'match', 'open')) {
      if (!m.ref.startsWith('lob_') || restored.has(m.ref)) continue;
      await this.closeLobbyCard(m, renderCancelled(), 'cancelled');
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
        players: snapshot.players.map((p) => ({
          ...this.player(p), ready: snapshot.ready.includes(p), blocked: mm.readyBlock(p) !== null,
        })),
        options: snapshot.options.map((c) => ({ campaign: c, name: campaignDisplayName(this.deps.db, c), votes: snapshot.votes[c] ?? 0 })),
        voiceRequired: getSetting(db, 'require_voice_to_ready') === '1',
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
      await this.closeLobbyCard(m, payload, failure ? 'failed' : 'cancelled');
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
        campaignName: campaignDisplayName(this.deps.db, row.campaign),
        publicUrl: this.deps.publicUrl,
        state,
        teamA: teamA.map((p) => this.player(p)),
        teamB: teamB.map((p) => this.player(p)),
        voice: this.deps.voice?.channelsFor(matchId) ?? null,
        unlinked: [...teamA, ...teamB].map((p) => this.player(p)).filter((p) => !p.discordId).map((p) => p.name),
        canSpectate: spectateFor(db, row.server_id) !== null,
      });
      // Skipped for 'aborted': closeMatchCard below moves the card to the
      // admin channel, and editing it in place first would both cost an extra
      // Discord call and flash the outcome in #queue-here on the way out.
      if (state !== 'aborted') await this.upsert('match', m.ref, payload);

      if (state === 'live' && !getMessage(db, 'live', m.ref)) {
        const players = [...teamA, ...teamB].map((p) => this.player(p));
        const ids = players.filter((p) => p.discordId).map((p) => p.discordId!);
        // No button of its own: the match card right above it already has
        // Connect, and two of them a few lines apart is the clutter. This
        // message exists purely to notify, because an edit never pings.
        const ping: MessagePayload = {
          content: `${ids.map((id) => `<@${id}>`).join(' ')}\nPUG #${matchId}: the server is ready. Press **Connect** on the match card above.`.trim(),
          embeds: [],
          components: [],
          mentionUserIds: ids,
        };
        const messageId = await this.deps.transport.send(channelId, ping);
        saveMessage(db, { kind: 'live', ref: m.ref, channelId, messageId, state: 'done' });
        posted = true;
      }

      if (state === 'finished' && row.winner) {
        if (!getMessage(db, 'result', m.ref)) {
          const resultsChannel = getSetting(db, 'discord_results_channel_id') || channelId;
          const messageId = await this.deps.transport.send(resultsChannel, renderResult({
            matchId,
            campaignName: campaignDisplayName(this.deps.db, row.campaign),
            publicUrl: this.deps.publicUrl,
            scoreA: row.team_a_score,
            scoreB: row.team_b_score,
            winner: row.winner,
            teamA: teamA.map((p) => this.resultPlayer(p, matchId)),
            teamB: teamB.map((p) => this.resultPlayer(p, matchId)),
          }));
          saveMessage(db, { kind: 'result', ref: m.ref, channelId: resultsChannel, messageId, state: 'done' });
          posted = true;
        }
        setMessageState(db, 'match', m.ref, 'done');
        // The result card is the record from here on, and it links to the
        // match page. What is left in the queue channel is a ready check, a
        // vote and two dead buttons, so it goes.
        await this.drop('live', m.ref);
        await this.drop('match', m.ref);
      } else if (state === 'aborted') {
        await this.closeMatchCard(m, payload);
        await this.drop('live', m.ref);
      }
    }

    if (this.deps.voice) await this.deps.voice.sweep().catch((err) => console.error('[discord] voice sweep failed:', err));

    // 4. The queue-filling alert, before the panel so the panel still ends up
    //    last in the channel.
    const q = mm.publicQueue();
    if (await this.maybeAlert(q.count)) posted = true;

    // 5. The panel, kept last in the channel.
    const panel = renderPanel({
      publicUrl: this.deps.publicUrl,
      size: QUEUE_SIZE,
      players: q.players.map((p) => this.player(p.steamid)),
      phase: q.phase,
      alertRoleId: getSetting(db, 'discord_pug_role_id') || undefined,
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

  /**
   * Announce that the queue is filling, at most once per threshold per fill.
   *
   * Three guards, and each exists for a different way this goes wrong:
   *
   * - `announced` stops the same threshold firing twice while the queue hovers
   *   there. Somebody leaving and rejoining at 6/8 must not re-ping.
   * - the reset at zero is what lets the NEXT fill announce again. Resetting on
   *   any decrease instead would re-arm on ordinary churn.
   * - the cooldown covers the case the other two cannot: two thresholds crossed
   *   in quick succession, which is two pings a minute apart for one filling
   *   queue. The higher one is worth more, so it wins and the lower is dropped.
   *
   * Returns whether a message was posted, so the caller knows to re-post the
   * panel below it.
   */
  private async maybeAlert(count: number): Promise<boolean> {
    const { db, channelId } = this.deps;
    const roleId = getSetting(db, 'discord_pug_role_id');
    if (!roleId) return false;

    // An empty queue is a fresh start: re-arm every threshold.
    if (count === 0) {
      this.announced = 0;
      return false;
    }

    const thresholds = safeThresholds(getSetting(db, 'discord_queue_thresholds'))
      .filter((t) => t > 0 && t < QUEUE_SIZE)
      .sort((a, b) => a - b);
    // The highest threshold this queue has reached. Using the highest rather
    // than an exact match means a pass that sees 4 -> 7 in one go announces 7,
    // not nothing: the sync loop is periodic and does not see every join.
    const reached = thresholds.filter((t) => count >= t).pop() ?? 0;
    if (reached === 0 || reached <= this.announced) return false;

    const now = this.deps.now?.() ?? Date.now();
    if (now - this.lastAlertMs < ALERT_COOLDOWN_MS) {
      // Still mark it announced. The point of the cooldown is to drop this
      // ping, not to hold it until the cooldown expires and fire it late.
      this.announced = reached;
      return false;
    }

    const payload = renderQueueAlert({
      count, size: QUEUE_SIZE, roleId, publicUrl: this.deps.publicUrl,
    });
    try {
      const messageId = await this.deps.transport.send(channelId, payload);
      saveMessage(db, { kind: 'alert', ref: String(now), channelId, messageId, state: 'done' });
    } catch (err) {
      // Never fatal, and deliberately still marked announced: a Discord outage
      // must not turn into a retry on every pass for the rest of the evening.
      console.error('[discord] queue alert failed:', err);
    }
    this.announced = reached;
    this.lastAlertMs = now;
    return true;
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
    const result = await this.safeEdit(stored.channel_id, stored.message_id, { ...payload, mentionUserIds: [] });
    if (result === 'ok') {
      this.hashes.set(stored.message_id, hash);
      return false;
    }
    // Leave the cache alone on a failure: it records what Discord is showing,
    // and caching a payload that never arrived is what froze match 82's card
    // at "Setting up the server..." on 2026-09-20 while the match ran. Every
    // later pass then matched the hash and skipped the edit, so the retry the
    // catch promises never happened. Untouched, the next pass tries again.
    if (result === 'failed') return false;
    await this.post(kind, ref, payload, stored.state);
    return true;
  }

  private async post(kind: string, ref: string, payload: MessagePayload, state = 'open'): Promise<void> {
    const messageId = await this.deps.transport.send(this.deps.channelId, payload);
    saveMessage(this.deps.db, { kind, ref, channelId: this.deps.channelId, messageId, state });
    this.hashes.set(messageId, JSON.stringify(payload));
  }

  /** Remove one of our messages from its channel. The row is kept, marked
   *  'removed', so nothing reposts it and the history stays readable. */
  private async drop(kind: string, ref: string): Promise<void> {
    const stored = getMessage(this.deps.db, kind, ref);
    if (!stored) return;
    await this.deps.transport.remove(stored.channel_id, stored.message_id).catch(() => {});
    this.hashes.delete(stored.message_id);
    setMessageState(this.deps.db, kind, ref, 'removed');
  }

  /**
   * Close out a lobby card that will never become a match.
   *
   * The outcome used to be edited onto the card, which left a growing pile of
   * "ready check failed" and "lobby cancelled" embeds in #queue-here between
   * the live queue panel and the people trying to read it (owner,
   * 2026-09-20). It goes to the admin channel instead: naming who missed a
   * ready check is something an admin acts on, and the players who were in
   * the lobby are told on the site rather than in the channel.
   *
   * The edit is still the fallback when no admin channel is set, because the
   * alternative there is deleting the card and saying nothing anywhere.
   */
  private async closeLobbyCard(
    m: { ref: string; channel_id: string; message_id: string },
    payload: MessagePayload,
    state: 'failed' | 'cancelled',
  ): Promise<void> {
    const admin = getSetting(this.deps.db, 'discord_admin_channel_id') || '';
    if (!admin) {
      await this.safeEdit(m.channel_id, m.message_id, payload);
      setMessageState(this.deps.db, 'match', m.ref, state);
      return;
    }
    // State first. A Discord failure below must not leave the row 'open', or
    // the next pass finds the lobby gone again and posts a second copy.
    setMessageState(this.deps.db, 'match', m.ref, state);
    await this.deps.transport.remove(m.channel_id, m.message_id).catch((err) => {
      console.error('[discord] removing a dead lobby card failed:', err);
    });
    this.hashes.delete(m.message_id);
    await this.deps.transport.send(admin, payload).catch((err) => {
      console.error('[discord] posting a lobby outcome to the admin channel failed:', err);
    });
  }

  /**
   * Close out a match card for a match that ended with no result.
   *
   * Same reasoning as closeLobbyCard above, one step later in the lifecycle.
   * The aborted card used to stay in #queue-here because with no result posted
   * it was the only trace the match happened; three abandons in a row on
   * 2026-09-20 put three dead rosters between the queue panel and the people
   * trying to queue (owner). It is an admin's business anyway: who was in it
   * and how far it got is what an admin checks after a leaver, and the match
   * page it links to now serves an aborted match rather than 404ing.
   *
   * Editing in place stays the fallback when no admin channel is set, because
   * the alternative there is deleting the card and saying nothing anywhere.
   */
  private async closeMatchCard(
    m: { ref: string; channel_id: string; message_id: string },
    payload: MessagePayload,
  ): Promise<void> {
    const db = this.deps.db;
    const admin = getSetting(db, 'discord_admin_channel_id') || '';
    if (!admin) {
      await this.upsert('match', m.ref, payload);
      setMessageState(db, 'match', m.ref, 'done');
      return;
    }
    // State first, as in closeLobbyCard: a Discord failure below must not
    // leave the row 'open', or the next pass finds it again and posts a
    // second copy into the admin channel.
    setMessageState(db, 'match', m.ref, 'done');
    await this.deps.transport.remove(m.channel_id, m.message_id).catch((err) => {
      console.error('[discord] removing an aborted match card failed:', err);
    });
    this.hashes.delete(m.message_id);
    await this.deps.transport.send(admin, payload).catch((err) => {
      console.error('[discord] posting an aborted match to the admin channel failed:', err);
    });
  }

  /**
   * 'ok' when Discord has the payload, 'gone' when the message no longer
   * exists and the caller should repost, 'failed' when the edit did not land
   * and the caller must not record it as applied.
   */
  private async safeEdit(
    channelId: string, messageId: string, payload: MessagePayload,
  ): Promise<'ok' | 'gone' | 'failed'> {
    try {
      return await this.deps.transport.edit(channelId, messageId, payload) ? 'ok' : 'gone';
    } catch (err) {
      console.error('[discord] edit failed:', err);
      return 'failed'; // transient: keep the message, retry on a later pass
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
