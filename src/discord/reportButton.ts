import { createHash } from 'node:crypto';
import type { DB } from '../db.js';
import { getSetting } from '../settings.js';
import { fileReport, latestSharedMatch, REPORT_CATEGORIES } from '../tickets/filing.js';
import { playerByDiscordId } from '../players.js';
import { REPORT_LABELS } from './commands.js';
import type { BotInteraction, BotTransport, InteractionReply, MessagePayload, ModalDef } from './transport.js';

/** A player the reporter could mean. */
export interface Candidate { steamid: string; name: string }

/**
 * Everyone the reporter has shared a match with, most recent match first,
 * one row each. Feeds the form's dropdown, which Discord caps at 25 options:
 * the default of 24 leaves room for the sentinel option.
 *
 * Filters to 'live', 'completed', and 'aborted' matches. This includes aborted
 * matches because that is when someone is most likely to be reported for going
 * AFK or abandoning mid-match. We exclude only 'configuring' matches, which had
 * lobbies that filled but never started a server.
 */
export function recentCoPlayers(db: DB, steamid: string, limit = 24): Candidate[] {
  return db.prepare(
    `SELECT p.steamid AS steamid, p.name AS name, MAX(mine.match_id) AS last_match
       FROM match_players mine
       JOIN match_players theirs
         ON theirs.match_id = mine.match_id AND theirs.player_id != mine.player_id
       JOIN players p ON p.steamid = theirs.player_id
       JOIN matches m ON m.id = mine.match_id
      WHERE mine.player_id = ? AND m.state IN ('live', 'completed', 'aborted')
      GROUP BY p.steamid
      ORDER BY last_match DESC
      LIMIT ?`,
  ).all(steamid, limit) as Candidate[];
}

/**
 * Players whose name the reporter may have typed. Exact matches win outright:
 * someone called "Bob" must not be buried by everyone called "Bobby". Only
 * when nothing matches exactly do we widen to a substring.
 *
 * The typed text goes into LIKE, so '%' and '_' are escaped. Without this a
 * reporter typing '%' matches the whole player list, which reads as the
 * feature being broken rather than as a wildcard.
 */
export function resolveByName(db: DB, typed: string, limit = 6): Candidate[] {
  const name = typed.trim();
  if (!name) return [];
  const exact = db.prepare(
    'SELECT steamid, name FROM players WHERE lower(name) = lower(?) ORDER BY name LIMIT ?',
  ).all(name, limit) as Candidate[];
  if (exact.length > 0) return exact;
  const escaped = name.replace(/[\\%_]/g, (c) => `\\${c}`);
  return db.prepare(
    `SELECT steamid, name FROM players
      WHERE lower(name) LIKE '%' || lower(?) || '%' ESCAPE '\\'
      ORDER BY name LIMIT ?`,
  ).all(escaped, limit) as Candidate[];
}

/** Custom id prefix. 'r:' is the admin feed and 't:' is tickets. */
export const REPORT_PREFIX = 'rp:';
/** The dropdown entry meaning "I will type the name instead". A modal select
 *  has no optional flag, so this sentinel is what lets the dropdown be
 *  skipped without the form refusing to submit. */
export const OTHER = '__other';
/** Discord's ceiling on a select option label. */
const LABEL_MAX = 100;

const clip = (s: string) => (s.length <= LABEL_MAX ? s : `${s.slice(0, LABEL_MAX - 1)}…`);

/** The form, built for this reporter: the dropdown is their own recent
 *  opponents, so the common case is one pick rather than any typing. */
export function reportModal(db: DB, reporter: string): ModalDef {
  return {
    customId: `${REPORT_PREFIX}new`,
    title: 'Report a player',
    fields: [
      {
        kind: 'select',
        id: 'who',
        label: 'Who are you reporting?',
        options: [
          { label: 'Someone else (I will type the name below)', value: OTHER },
          ...recentCoPlayers(db, reporter).map((c) => ({ label: clip(c.name), value: c.steamid })),
        ],
      },
      { kind: 'text', id: 'name', label: 'Or type their name', style: 'short', required: false, maxLength: 100 },
      {
        kind: 'select',
        id: 'reason',
        label: 'What happened?',
        options: REPORT_CATEGORIES.map((c) => ({ label: REPORT_LABELS[c], value: c })),
      },
      { kind: 'text', id: 'details', label: 'Details, in your own words', style: 'paragraph', required: false, maxLength: 1000 },
    ],
  };
}

/** Only the standing message's button answers with a form. The candidate
 *  buttons reply with a message, and the transport has to know the difference
 *  before it runs the handler. */
export function opensReportModal(customId: string): boolean {
  return customId === `${REPORT_PREFIX}open`;
}

const TICK_MS = 5 * 60_000;
/** How long a half-written report waits for its reporter to pick a name. */
const PENDING_MS = 60 * 60_000;

const BODY = [
  '**Something happened in a game? Tell the moderators.**',
  '',
  'Press the button below and fill in the form. Your report is private:',
  'the person you report is never told who reported them.',
].join('\n');

function standingPayload(): MessagePayload {
  return {
    content: BODY,
    embeds: [],
    components: [[{ kind: 'button', customId: `${REPORT_PREFIX}open`, label: 'Report a player', style: 'primary' }]],
  };
}

const hashOf = (p: MessagePayload) => createHash('sha256').update(JSON.stringify(p)).digest('hex').slice(0, 16);

export interface ReportButtonDeps {
  db: DB;
  transport: BotTransport;
  /** 0 disables the timer, which is what every test uses. */
  intervalMs?: number;
  now?: () => Date;
}

/**
 * Keeps one message with one button alive in the configured channel, and
 * clears out drafts nobody came back for.
 */
export class ReportButton {
  private timer: NodeJS.Timeout | null = null;

  constructor(private deps: ReportButtonDeps) {}

  start(): void {
    void this.tick();
    const every = this.deps.intervalMs ?? TICK_MS;
    if (every > 0) {
      this.timer = setInterval(() => { void this.tick(); }, every);
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    try {
      await this.ensureMessage();
    } catch (err) {
      console.error('[discord] report button:', err);
    }
    this.reapPending();
  }

  /** Rows nobody came back to finish. Not an error: someone opened the form,
   *  saw the list of names and thought better of it. */
  private reapPending(): void {
    const cutoff = new Date((this.deps.now?.() ?? new Date()).getTime() - PENDING_MS).toISOString();
    this.deps.db.prepare('DELETE FROM pending_reports WHERE created_at < ?').run(cutoff);
  }

  private async ensureMessage(): Promise<void> {
    const { db, transport } = this.deps;
    const channelId = getSetting(db, 'discord_report_channel_id') ?? '';
    const row = db.prepare('SELECT channel_id, message_id, hash FROM report_message WHERE id = 1')
      .get() as { channel_id: string; message_id: string; hash: string } | undefined;
    if (!channelId) return;

    const payload = standingPayload();
    const hash = hashOf(payload);

    // A changed setting moves the button. Take the old one down if we still
    // can, but never let a failure there stop the move: a stray button in an
    // abandoned channel still opens the form and still files a report, so it
    // is untidy rather than harmful.
    if (row && row.channel_id !== channelId) {
      await transport.remove(row.channel_id, row.message_id).catch(() => {});
    } else if (row && row.hash === hash) {
      // Nothing to say, but prove the message is still there. An edit that
      // returns false means Discord has lost it, and a failed edit reported
      // as success is what froze a match card in place before (32118ab).
      if (await transport.edit(row.channel_id, row.message_id, payload)) return;
    } else if (row) {
      if (await transport.edit(row.channel_id, row.message_id, payload)) {
        this.remember(channelId, row.message_id, hash);
        return;
      }
    }

    const messageId = await transport.send(channelId, payload);
    this.remember(channelId, messageId, hash);
  }

  private remember(channelId: string, messageId: string, hash: string): void {
    this.deps.db.prepare(
      `INSERT INTO report_message (id, channel_id, message_id, hash, updated_at)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET channel_id = excluded.channel_id,
         message_id = excluded.message_id, hash = excluded.hash, updated_at = excluded.updated_at`,
    ).run(channelId, messageId, hash, (this.deps.now?.() ?? new Date()).toISOString());
  }
}

/** How many same-named players are worth offering as buttons. Beyond this,
 *  asking for a better name beats a wall of buttons. */
const MAX_CHOICES = 5;

export interface ReportHandlerDeps { db: DB; adminSteamIds: string[]; now?: () => Date }

const say = (content: string, components: InteractionReply['payload']['components'] = []): InteractionReply =>
  ({ ephemeral: true, payload: { content, embeds: [], components } });

const LINK_FIRST = 'Link your Steam account first with `/link`, then you can file a report.';

export async function handleReportButton(
  deps: ReportHandlerDeps, i: Extract<BotInteraction, { kind: 'button' }>,
): Promise<InteractionReply> {
  const me = playerByDiscordId(deps.db, i.userId);
  if (!me) return say(LINK_FIRST);
  if (i.customId === `${REPORT_PREFIX}open`) {
    return { ephemeral: true, payload: { content: 'Opening the form...', embeds: [], components: [] }, modal: reportModal(deps.db, me.steamid) };
  }
  if (i.customId.startsWith(`${REPORT_PREFIX}pick:`)) {
    const [, , rawId, steamid] = i.customId.split(':');
    const row = deps.db.prepare('SELECT id, reporter_id, category, text, candidates FROM pending_reports WHERE id = ?')
      .get(Number(rawId)) as { id: number; reporter_id: string; category: string; text: string; candidates: string } | undefined;
    // Reaped after an hour, or already used: either way the words are gone
    // and the honest answer is to start again.
    if (!row) return say('That draft has expired, please file it again.');
    // The custom id travels through Discord, so the presser is checked
    // against the row rather than trusted.
    if (row.reporter_id !== me.steamid) return say('That choice is not yours to make.');
    if (!(JSON.parse(row.candidates) as string[]).includes(steamid)) {
      return say('That player was not one of the choices.');
    }
    const outcome = file(deps, row.reporter_id, steamid, row.category, row.text);
    // Only on success: a refusal (the daily limit, say) leaves the draft in
    // place so the reporter is not made to type it again. This has to come
    // from fileReport's own ok flag, never be guessed from the reply text:
    // reworded copy that happens to drift onto or off of some magic phrase
    // must not silently flip which side of this branch a report lands on.
    if (outcome.ok) {
      deps.db.prepare('DELETE FROM pending_reports WHERE id = ?').run(row.id);
    }
    return outcome.reply;
  }
  return say('That button no longer does anything.');
}

export async function handleReportModal(
  deps: ReportHandlerDeps, i: Extract<BotInteraction, { kind: 'modal' }>,
): Promise<InteractionReply> {
  const me = playerByDiscordId(deps.db, i.userId);
  if (!me) return say(LINK_FIRST);
  const category = i.fields.reason ?? '';
  const text = (i.fields.details ?? '').trim();
  const picked = i.fields.who ?? OTHER;

  if (picked !== OTHER) return file(deps, me.steamid, picked, category, text).reply;

  const typed = (i.fields.name ?? '').trim();
  if (!typed) return say('Pick someone from the list or type their name.');

  const found = resolveByName(deps.db, typed, MAX_CHOICES + 1);
  if (found.length === 0) {
    return say('No player here by that name. They may never have played on these servers.');
  }
  if (found.length === 1) return file(deps, me.steamid, found[0].steamid, category, text).reply;
  if (found.length > MAX_CHOICES) {
    return say('Several players share that name. Type more of it, or pick them from the list if you played together recently.');
  }
  return hold(deps, me.steamid, typed, category, text, found);
}

/** The one place a report is actually filed, so every path shares the same
 *  refusals and the same wording. Returns fileReport's own ok flag alongside
 *  the reply, so a caller that must act differently on success (the pick
 *  branch, deciding whether to delete a draft) branches on that flag rather
 *  than on the reply's user-facing copy, which can be reworded without
 *  warning and must never double as control flow. */
function file(
  deps: ReportHandlerDeps, reporter: string, targetId: string, category: string, text: string,
): { ok: boolean; reply: InteractionReply } {
  // '/report' gets its match from the same lookup. Without this, every report
  // filed through this button carried no match at all: moderators lost the
  // link on exactly the griefing and AFK reports the button exists to catch,
  // and fileReport's duplicate rule (keyed on the match) collapsed to "one
  // open report about this player, ever", refusing a second night's report
  // that '/report' would have let through.
  const matchId = latestSharedMatch(deps.db, reporter, targetId);
  const r = fileReport(deps.db, reporter, { targetId, category, text, matchId }, {
    adminSteamIds: deps.adminSteamIds, now: deps.now?.(),
  });
  if (!r.ok) return { ok: false, reply: say(`Could not file the report: ${r.error}.`) };
  return { ok: true, reply: say('Thanks. The moderators will look at it. The person you reported is never told who filed it.') };
}

/** Keep the words while the reporter says which of these people they meant. */
function hold(
  deps: ReportHandlerDeps, reporter: string, typed: string, category: string, text: string, found: Candidate[],
): InteractionReply {
  // Only the newest draft is ever useful: opening the form again means the
  // reporter is trying once more, and a stale draft's candidate buttons
  // already answer "expired" once it is gone, so nothing is lost by clearing
  // it early. This bounds the table at one row per reporter, which is a
  // resource bound, not a policy check: it must stay that, so nobody later
  // "upgrades" it into a banned/good-standing gate. That check belongs to
  // fileReport alone, which this path never reaches.
  deps.db.prepare('DELETE FROM pending_reports WHERE reporter_id = ?').run(reporter);
  const id = Number(deps.db.prepare(
    'INSERT INTO pending_reports (reporter_id, category, text, typed_name, candidates, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(reporter, category, text, typed, JSON.stringify(found.map((c) => c.steamid)),
    (deps.now?.() ?? new Date()).toISOString()).lastInsertRowid);
  return say(
    `More than one player is called "${typed}". Which one do you mean? Nothing is filed until you choose.`,
    [found.map((c) => ({ kind: 'button' as const, customId: `${REPORT_PREFIX}pick:${id}:${c.steamid}`, label: clip(c.name), style: 'secondary' as const }))],
  );
}
