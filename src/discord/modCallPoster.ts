import type { DB } from '../db.js';
import { getModCall, markModCallHandled, onModCall, onModCallHandled } from '../modCalls.js';
import { playerByDiscordId } from '../players.js';
import { getSetting } from '../settings.js';
import { inGoodStanding } from '../standing.js';
import { handlerLabel, renderModCallCard } from './modCallCard.js';
import type { BotInteraction, BotTransport, InteractionReply } from './transport.js';

const RETRY_MS = 30_000;
/** How far back the retry pass looks. A call older than this is stale news:
 *  it stays on the site's list, but pinging the mods for it now helps nobody. */
const RETRY_WINDOW_MS = 24 * 60 * 60_000;

const say = (content: string): InteractionReply => ({
  ephemeral: true,
  payload: { content, embeds: [], components: [], mentionUserIds: [] },
});

/**
 * Posts in-game mod calls to the admin channel, one card per call, with the
 * calls folded into it listed on the parent's card.
 *
 * Not an admin feed event: the feed toggles do not silence it. Every piece of
 * work runs on one promise chain, as AdminFeedPoster's does, so a second call
 * a second after the first cannot race the first card's send: by the time the
 * fold is delivered the parent either has its message id or is still pending,
 * and a pending parent's first post already lists the child.
 *
 * The database is the queue. A row stays `pending` until Discord has taken
 * it, so a blank admin channel, a Discord outage or a web restart loses
 * nothing: the retry timer picks up every pending parent from the last day.
 */
export class ModCallPoster {
  private chain: Promise<void> = Promise.resolve();
  private offs: (() => void)[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private deps: { db: DB; transport: BotTransport; publicUrl: string; retryMs?: number }) {}

  start(): void {
    this.offs = [
      onModCall((id) => { void this.enqueue(() => this.deliver(id)); }),
      // Handled from the button or the site alike: the card follows the row.
      onModCallHandled((id) => { void this.enqueue(() => this.refresh(id)); }),
    ];
    void this.retryNow();
    const every = this.deps.retryMs ?? RETRY_MS;
    if (every > 0) {
      this.timer = setInterval(() => { void this.retryNow(); }, every);
      this.timer.unref();
    }
  }

  stop(): void {
    for (const off of this.offs) off();
    this.offs = [];
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Resolves once every piece of work queued so far is done (tests). */
  idle(): Promise<void> {
    return this.chain;
  }

  /** One pass over the parents still waiting for their first post. */
  retryNow(): Promise<void> {
    return this.enqueue(async () => {
      const since = new Date(Date.now() - RETRY_WINDOW_MS).toISOString();
      const ids = this.deps.db.prepare(
        "SELECT id FROM mod_calls WHERE post_state = 'pending' AND folded_into IS NULL AND created_at > ? ORDER BY id",
      ).all(since) as { id: number }[];
      // One at a time and each on its own: a send that fails leaves that row
      // pending for the next pass and does not stop the rest.
      for (const { id } of ids) await this.deliver(id);
    });
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(work).catch((err) => console.error('[modcall] post failed:', err));
    return this.chain;
  }

  /**
   * A folded call re-renders its parent's card; a parent is sent once. The
   * row is read here, inside the chain, not when the work was queued, so a
   * retry pass and the live event for the same row cannot both send it.
   */
  private async deliver(id: number): Promise<void> {
    const { db, transport, publicUrl } = this.deps;
    const row = getModCall(db, id);
    if (!row) return;
    if (row.folded_into !== null) {
      await this.refresh(row.folded_into);
      return;
    }
    if (row.post_state !== 'pending') return;
    // Off means posts nothing, including calls that were waiting on Discord or
    // a blank channel when an admin switched it off. Skipped, not left pending,
    // so turning calls back on does not flush a backlog of stale pings.
    if (getSetting(db, 'mod_calls_enabled') === '0') {
      const note = row.note ? `${row.note}. Calls are turned off` : 'Calls are turned off';
      db.prepare("UPDATE mod_calls SET post_state = 'skipped', note = ? WHERE id = ?").run(note, id);
      return;
    }
    // Blank channel: left pending. The site's banner says calls are not
    // reaching Discord, and the retry pass posts it once the channel is set.
    const channelId = getSetting(db, 'discord_admin_channel_id') ?? '';
    if (!channelId) return;
    try {
      const messageId = await transport.send(channelId, renderModCallCard(db, row, publicUrl));
      db.prepare("UPDATE mod_calls SET discord_message_id = ?, post_state = 'posted' WHERE id = ?").run(messageId, id);
    } catch (err) {
      console.error('[modcall] post failed:', err);
    }
  }

  /** Edit a posted card to match its row. A card still pending needs nothing:
   *  its first post is rendered from the database as it is then. */
  private async refresh(parentId: number): Promise<void> {
    const { db, transport, publicUrl } = this.deps;
    const parent = getModCall(db, parentId);
    if (!parent?.discord_message_id) return;
    const channelId = getSetting(db, 'discord_admin_channel_id') ?? '';
    if (!channelId) return;
    try {
      await transport.edit(channelId, parent.discord_message_id, renderModCallCard(db, parent, publicUrl));
    } catch (err) {
      console.error('[modcall] edit failed:', err);
    }
  }

  /**
   * custom_id scheme: mc:<callId>:handle. The presser is checked from scratch
   * on every press, as the ticket buttons do: the card sits in the channel for
   * good, and whoever presses it may have lost their staff flag or been banned
   * since it was posted. Staff is checked before the call is looked up so a
   * non-staff presser gets the same answer for every id.
   */
  async handleButton(i: Extract<BotInteraction, { kind: 'button' }>): Promise<InteractionReply> {
    const m = /^mc:(\d+):handle$/.exec(i.customId);
    if (!m) return say('That button no longer does anything.');
    const { db } = this.deps;
    const p = playerByDiscordId(db, i.userId);
    if (!p || (p.is_admin !== 1 && p.is_mod !== 1) || !inGoodStanding(db, p.steamid)) return say('Staff only.');
    const id = Number(m[1]);
    // The rules are markModCallHandled's, shared with the site. The staff
    // member a call is about gets the same answer as anyone else who may not
    // handle it: the card hides who called, and the reply should not say more
    // than that. The refresh comes from its handled signal.
    const r = markModCallHandled(db, id, { steamid: p.steamid, discordId: i.userId });
    if (!r.ok) {
      if (r.why === 'no_call') return say('No such call.');
      if (r.why === 'about_you') return say('Staff only.');
      if (r.why === 'folded') return say('That call is folded into another card: handle that one.');
      return say(`Already handled by ${handlerLabel(db, getModCall(db, id)!) ?? 'someone'}.`);
    }
    return say('Marked as yours.');
  }
}
