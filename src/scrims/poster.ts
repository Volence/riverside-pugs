import { createHash } from 'node:crypto';
import { campaignDisplayName } from '../campaignRegistry.js';
import type { DB } from '../db.js';
import { escapeName } from '../identity.js';
import { getMessage, messagesInState, saveMessage, setMessageState } from '../discord/messageStore.js';
import { getPlayer } from '../players.js';
import { getSetting } from '../settings.js';
import { competitivePublic } from '../teams/access.js';
import { getTeam } from '../teams/teams.js';
import type { BotTransport, MessagePayload } from '../discord/transport.js';
import { nightWindow } from './night.js';
import { lengthLabel, sideSr, type ScrimSide } from './rules.js';
import { getPost, type PostRow, type PostStatus } from './scrims.js';

/**
 * Keeps one Discord card per public scrim post (plan 1, Task 4), in the
 * `#scrims` channel the `discord_scrims_channel_id` setting names. A direct
 * challenge (target_team_id set) never gets a card: it travels only by DM and
 * site notice (src/scrims/messages.ts).
 *
 * Same shape as ReportButton (hash/edit/repost-when-gone, a thrown edit keeps
 * the old hash so the next tick tries again) and SkeetStreakPoster (the
 * start/stop/tickNow promise chain, so a caller's `void tickNow()` never
 * overlaps two ticks). messageStore.ts (kind 'scrim', ref the post id) is the
 * source of truth for which message is which; the rendered hash lives only in
 * memory, keyed by post id, same as ReportButton's single row.
 *
 * The channel is read from the setting only when a post gets its first card.
 * Once posted, a row keeps the channel it was posted to in discord_messages,
 * so changing the setting moves new cards to the new channel without
 * disturbing old ones still open there.
 */

const KIND = 'scrim';
const NIGHT_KIND = 'scrim_night';
/** Plan 2 Ruling 7: how far ahead of the window's start the reminder goes out. */
const NIGHT_REMINDER_LEAD_MS = 2 * 3_600_000;

const CLOSED_LABEL: Partial<Record<PostStatus, string>> = {
  booked: 'Booked',
  withdrawn: 'Withdrawn',
  expired: 'Expired',
};

type SideRef = Pick<PostRow, 'team_id' | 'captain_steamid'>;

function sideTitle(db: DB, s: SideRef): string {
  if (s.team_id !== null) return escapeName(getTeam(db, s.team_id)?.name ?? 'A team');
  return escapeName(getPlayer(db, s.captain_steamid)?.name ?? 'Someone');
}

const sideOf = (s: SideRef): ScrimSide => (s.team_id !== null ? { teamId: s.team_id } : { captain: s.captain_steamid });

const hashOf = (p: MessagePayload) => createHash('sha256').update(JSON.stringify(p)).digest('hex').slice(0, 16);

/**
 * The open (or pending) card. A Status field is included alongside the
 * fields Ruling 5 names (when, length, campaigns, average SR and range, the
 * note) because a post accepting an offer (open -> pending) is the one state
 * change this card can show without a new post id: without it, the card
 * would sit unchanged in Discord while the site already shows an offer under
 * review.
 */
function renderOpenCard(db: DB, p: PostRow, publicUrl: string): MessagePayload {
  const campaigns = (JSON.parse(p.campaigns_json) as string[]).map((c) => campaignDisplayName(db, c));
  const sr = sideSr(db, sideOf(p));
  const range = p.sr_range === null ? 'open' : `± ${p.sr_range}`;
  const unix = Math.floor(Date.parse(p.starts_at) / 1000);
  const note = p.note.trim();
  const fields = [
    { name: 'Status', value: p.status === 'pending' ? 'An offer is under review' : 'Open' },
    { name: 'When', value: `<t:${unix}:F>` },
    { name: 'Length', value: lengthLabel(campaigns.length, p.block_minutes) },
    { name: 'Campaigns', value: campaigns.length > 0 ? campaigns.join(', ') : 'Any' },
    { name: 'Average SR', value: `${sr} (${range})` },
    ...(note !== '' ? [{ name: 'Note', value: escapeName(note) }] : []),
  ];
  return {
    embeds: [{ title: sideTitle(db, p), fields }],
    components: [[{ kind: 'link' as const, url: `${publicUrl}/scrims?post=${p.id}`, label: 'Accept on the site' }]],
    mentionUserIds: [],
  };
}

/** The closed version: the side name stays the title, the button is gone,
 *  and the body says what happened to it. */
function renderClosedCard(db: DB, p: PostRow): MessagePayload {
  const label = CLOSED_LABEL[p.status] ?? p.status;
  return {
    embeds: [{ title: sideTitle(db, p), description: label }],
    components: [],
    mentionUserIds: [],
  };
}

export interface ScrimPosterDeps {
  db: DB;
  transport: BotTransport;
  publicUrl: string;
  /** 0 disables the timer, which is what every test uses. */
  tickMs?: number;
}

const TICK_MS = 2 * 60_000;

export class ScrimPoster {
  private chain: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** The last payload hash sent or edited for a post, by post id. Never
   *  persisted: a restart just re-sends the hash it computes fresh next tick,
   *  which costs at most one redundant edit per open post. */
  private hashes = new Map<number, string>();

  constructor(private deps: ScrimPosterDeps) {}

  start(): void {
    void this.tickNow();
    const every = this.deps.tickMs ?? TICK_MS;
    if (every > 0) {
      this.timer = setInterval(() => { void this.tickNow(); }, every);
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Queued on the same chain as start()'s own first pass and the timer, so
   *  two ticks never run at once: a caller (ScrimBoard's minute tick) only
   *  ever does `poster.tickNow()` without awaiting it. */
  tickNow(): Promise<void> {
    this.chain = this.chain.then(() => this.tick()).catch((err) => console.error('[scrims] poster tick failed:', err));
    return this.chain;
  }

  private async tick(): Promise<void> {
    await this.postAndEdit();
    await this.close();
    await this.sendNightReminder();
  }

  /** Posts a card for every open or pending public post with none yet, and
   *  edits any whose rendered payload changed. A blank channel setting, or
   *  competitive play not yet public (`competitivePublic`, off under 'off'
   *  and 'admins'), just leaves posts with no card waiting for the next tick;
   *  posts that already have one keep being edited in their own stored
   *  channel regardless, so an existing card still updates or closes even
   *  after the switch moves back off 'everyone'. */
  private async postAndEdit(): Promise<void> {
    const { db, transport, publicUrl } = this.deps;
    const channelId = getSetting(db, 'discord_scrims_channel_id') ?? '';
    const live = db.prepare(
      "SELECT * FROM scrim_posts WHERE status IN ('open','pending') AND target_team_id IS NULL ORDER BY id",
    ).all() as PostRow[];

    for (const p of live) {
      const ref = String(p.id);
      const payload = renderOpenCard(db, p, publicUrl);
      const hash = hashOf(payload);
      const row = getMessage(db, KIND, ref);

      if (!row) {
        if (!channelId || !competitivePublic(db)) continue;
        try {
          const messageId = await transport.send(channelId, payload);
          saveMessage(db, { kind: KIND, ref, channelId, messageId });
          this.hashes.set(p.id, hash);
        } catch (err) {
          // Nothing saved: the next tick tries posting it again.
          console.error('[scrims] poster send failed:', err instanceof Error ? err.message : err);
        }
        continue;
      }

      if (this.hashes.get(p.id) === hash) continue;
      try {
        if (await transport.edit(row.channel_id, row.message_id, payload)) {
          this.hashes.set(p.id, hash);
          continue;
        }
        // Gone (deleted by hand): sent again, to the same channel the row
        // already belongs to.
        const messageId = await transport.send(row.channel_id, payload);
        saveMessage(db, { kind: KIND, ref, channelId: row.channel_id, messageId });
        this.hashes.set(p.id, hash);
      } catch (err) {
        // The old hash is kept, so the next tick's comparison still finds a
        // change and tries the edit again, the same as ReportButton.
        console.error('[scrims] poster edit failed:', err instanceof Error ? err.message : err);
      }
    }
  }

  /** Every card still marked 'open' whose post has since booked, withdrawn
   *  or expired gets edited to the closed line once, then its row's state is
   *  set to 'closed' so it is never touched again. If the message is gone
   *  (edit returns false) a fresh closed card is sent to the row's own
   *  channel and the row is updated to it, so the final state is always
   *  shown somewhere rather than silently marked closed with nothing to see.
   *  A thrown edit or send leaves the state as 'open', so the next tick
   *  retries it. */
  private async close(): Promise<void> {
    const { db, transport } = this.deps;
    for (const row of messagesInState(db, KIND, 'open')) {
      const p = getPost(db, Number(row.ref));
      if (!p || (p.status !== 'booked' && p.status !== 'withdrawn' && p.status !== 'expired')) continue;
      const payload = renderClosedCard(db, p);
      try {
        if (await transport.edit(row.channel_id, row.message_id, payload)) {
          setMessageState(db, KIND, row.ref, 'closed');
        } else {
          const messageId = await transport.send(row.channel_id, payload);
          saveMessage(db, { kind: KIND, ref: row.ref, channelId: row.channel_id, messageId, state: 'closed' });
        }
        this.hashes.delete(p.id);
      } catch (err) {
        console.error('[scrims] poster close failed:', err instanceof Error ? err.message : err);
      }
    }
  }

  /** The weekly scrim night reminder (plan 2 Ruling 7): once, 2 hours before
   *  the window opens (never after it has opened), while competitive play is
   *  public and the channel is set. discord_messages (kind scrim_night, ref
   *  the window's own starts_at) is the record of having sent it, saved
   *  already closed since there is no card to keep editing; a restart just
   *  finds the row and sends nothing more. A thrown send leaves no row, so
   *  the next tick inside the lead tries again. */
  private async sendNightReminder(): Promise<void> {
    const { db, transport, publicUrl } = this.deps;
    const channelId = getSetting(db, 'discord_scrims_channel_id') ?? '';
    if (!channelId || !competitivePublic(db)) return;
    const window = nightWindow(db);
    if (!window) return;
    const startMs = Date.parse(window.startsAt);
    const nowMs = Date.now();
    if (nowMs < startMs - NIGHT_REMINDER_LEAD_MS || nowMs >= startMs) return;
    if (getMessage(db, NIGHT_KIND, window.startsAt)) return;

    const unix = Math.floor(startMs / 1000);
    const payload: MessagePayload = {
      content: `Scrim night starts in about 2 hours (<t:${unix}:R>). Post or accept a scrim: ${publicUrl}/scrims`,
      embeds: [], components: [], mentionUserIds: [],
    };
    try {
      const messageId = await transport.send(channelId, payload);
      saveMessage(db, { kind: NIGHT_KIND, ref: window.startsAt, channelId, messageId, state: 'closed' });
    } catch (err) {
      console.error('[scrims] night reminder send failed:', err instanceof Error ? err.message : err);
    }
  }
}
