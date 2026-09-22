import { createHash } from 'node:crypto';
import type { DB } from '../db.js';
import { getSetting } from '../settings.js';
import {
  fileReport, latestSharedMatch, MAX_TEXT, REPORT_CATEGORIES,
  type DiscordReporter, type PickedTarget,
} from '../tickets/filing.js';
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
 *  opponents, so the common case is one pick rather than any typing. `null`
 *  for a Discord-only reporter, who has no match history to draw the
 *  dropdown from: the sentinel is all it holds. */
export function reportModal(db: DB, reporter: string | null): ModalDef {
  return {
    customId: `${REPORT_PREFIX}new`,
    title: 'Report a player',
    fields: [
      {
        kind: 'select',
        id: 'who',
        label: 'Someone you played with?',
        options: [
          { label: 'Someone else (pick or type them below)', value: OTHER },
          ...(reporter ? recentCoPlayers(db, reporter) : []).map((c) => ({ label: clip(c.name), value: c.steamid })),
        ],
      },
      { kind: 'user', id: 'member', label: 'Or pick them from the Discord', required: false },
      { kind: 'text', id: 'name', label: 'Or type their in-game name', style: 'short', required: false, maxLength: 100 },
      {
        kind: 'select',
        id: 'reason',
        label: 'What happened?',
        options: REPORT_CATEGORIES.map((c) => ({ label: REPORT_LABELS[c], value: c })),
      },
      { kind: 'text', id: 'details', label: 'Details, in your own words', style: 'paragraph', required: false, maxLength: MAX_TEXT },
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

// Deliberately not "something happened in a game". The first wording said
// that and the owner's first piece of feedback was that it reads as though
// only in-game incidents count. Someone can be creepy in a channel, in a
// thread or in a DM, and those are the reports this community most needs to
// hear about, so the opening line has to say so before anyone decides they
// are in the wrong place.
const BODY = [
  '**Something happened? Tell the moderators.**',
  '',
  'In a game, here in Discord, or in a DM. If someone has made you or',
  'anyone else uncomfortable, we want to know.',
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
      // Inside the same try as ensureMessage: start() and the interval both
      // call this as `void this.tick()`, so a throwing DELETE out here would
      // become an unhandled rejection, which ends the process on this Node
      // version rather than just skipping a reap until the next tick.
      this.reapPending();
    } catch (err) {
      console.error('[discord] report button:', err);
    }
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

/** Either side of the form: a linked player, or a Discord member with no
 *  linked Steam account at all. */
type Me = { kind: 'player'; steamid: string } | DiscordReporter;

/** Who pressed a button or submitted a modal. A linked Discord account is
 *  always the player; everyone else is reported exactly as Discord gave
 *  them, with their current timeout (a button interaction carries none, so
 *  it comes through as null). */
function whoIsPressing(db: DB, i: { userId: string; userName: string; presserTimedOutUntil?: string | null }): Me {
  const p = playerByDiscordId(db, i.userId);
  return p ? { kind: 'player', steamid: p.steamid }
    : { kind: 'discord', discordId: i.userId, name: i.userName, timedOutUntil: i.presserTimedOutUntil ?? null };
}

export async function handleReportButton(
  deps: ReportHandlerDeps, i: Extract<BotInteraction, { kind: 'button' }>,
): Promise<InteractionReply> {
  const me = whoIsPressing(deps.db, i);
  if (i.customId === `${REPORT_PREFIX}open`) {
    return {
      ephemeral: true,
      payload: { content: 'Opening the form...', embeds: [], components: [] },
      modal: reportModal(deps.db, me.kind === 'player' ? me.steamid : null),
    };
  }
  if (i.customId.startsWith(`${REPORT_PREFIX}pick:`)) {
    const [, , rawId, steamid] = i.customId.split(':');
    // The custom id travels through Discord, so the presser is checked
    // against the row rather than trusted: scoped into the query itself,
    // so "no such draft" and "that draft is not yours" come back as the
    // same answer on purpose. A distinct "not yours" reply would let
    // someone probe whether a given draft id exists at all; a missing row
    // and someone else's row must be indistinguishable from the outside.
    // IS rather than = : either side of the scoping pair can be NULL (a
    // Discord-only reporter has no reporter_id), and NULL = NULL is NULL,
    // which a WHERE treats as no match at all.
    const row = deps.db.prepare(
      'SELECT id, category, text, candidates FROM pending_reports WHERE id = ? AND reporter_id IS ? AND reporter_discord_id IS ?',
    ).get(
      Number(rawId), me.kind === 'player' ? me.steamid : null, me.kind === 'discord' ? me.discordId : null,
    ) as { id: number; category: string; text: string; candidates: string } | undefined;
    // Reaped after an hour, already used, or somebody else's: either way the
    // honest answer is the same, to start again.
    if (!row) return say('That draft has expired, please file it again.');
    if (!(JSON.parse(row.candidates) as string[]).includes(steamid)) {
      return say('That player was not one of the choices.');
    }
    const outcome = file(deps, me, { targetId: steamid }, row.category, row.text);
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
  const me = whoIsPressing(deps.db, i);
  const category = i.fields.reason ?? '';
  const text = (i.fields.details ?? '').trim();
  const picked = i.fields.who ?? OTHER;
  const member = i.picked?.member;

  if (picked !== OTHER && member) {
    // The dropdown and the member picker disagree: refuse rather than guess
    // which the reporter meant, but keep what they wrote so nothing typed is
    // lost to a form they now have to fill in again.
    const memberPlayer = playerByDiscordId(deps.db, member.id);
    if (memberPlayer?.steamid !== picked) {
      return say(`You picked two different people. Pick one and send the form again.${text ? `\n\nWhat you wrote:\n> ${text.replace(/\n/g, '\n> ')}` : ''}`);
    }
  }
  if (picked !== OTHER) return file(deps, me, { targetId: picked }, category, text).reply;
  if (member) {
    return file(deps, me, {
      targetDiscord: { discordId: member.id, name: member.name, bot: member.bot, administrator: member.administrator },
    }, category, text).reply;
  }

  const typed = (i.fields.name ?? '').trim();
  if (!typed) return say('Pick someone from the list or type their name.');

  const found = resolveByName(deps.db, typed, MAX_CHOICES + 1);
  if (found.length === 0) {
    return say('No player here by that name. They may never have played on these servers.');
  }
  if (found.length === 1) return file(deps, me, { targetId: found[0].steamid }, category, text).reply;
  if (found.length > MAX_CHOICES) {
    return say('Several players share that name. Type more of it, or pick them from the list if you played together recently.');
  }
  return hold(deps, me, typed, category, text, found);
}

/** The one place a report is actually filed, so every path shares the same
 *  refusals and the same wording. Returns fileReport's own ok flag alongside
 *  the reply, so a caller that must act differently on success (the pick
 *  branch, deciding whether to delete a draft) branches on that flag rather
 *  than on the reply's user-facing copy, which can be reworded without
 *  warning and must never double as control flow.
 *
 *  A picked Discord target never travels in the report body: only
 *  `deps.targetDiscord` carries it, so fileReport is the one place that
 *  turns Discord facts (bot, administrator) into a filing decision. */
function file(
  deps: ReportHandlerDeps, reporter: Me, target: { targetId: string } | { targetDiscord: PickedTarget },
  category: string, text: string,
): { ok: boolean; reply: InteractionReply } {
  // '/report' gets its match from the same lookup. Without this, every report
  // filed through this button carried no match at all: moderators lost the
  // link on exactly the griefing and AFK reports the button exists to catch,
  // and fileReport's duplicate rule (keyed on the match) collapsed to "one
  // open report about this player, ever", refusing a second night's report
  // that '/report' would have let through. A match is only ever attached
  // between two players.
  const matchId = reporter.kind === 'player' && 'targetId' in target
    ? latestSharedMatch(deps.db, reporter.steamid, target.targetId) : null;
  const body = { category, text, matchId, ...('targetId' in target ? { targetId: target.targetId } : {}) };
  const r = fileReport(deps.db, reporter.kind === 'player' ? reporter.steamid : reporter, body, {
    adminSteamIds: deps.adminSteamIds,
    now: deps.now?.(),
    ...('targetDiscord' in target ? { targetDiscord: target.targetDiscord } : {}),
  });
  if (!r.ok) return { ok: false, reply: say(`Could not file the report: ${r.error}.`) };
  return { ok: true, reply: say('Thanks. The moderators will look at it. The person you reported is never told who filed it.') };
}

/** Keep the words while the reporter says which of these people they meant. */
function hold(
  deps: ReportHandlerDeps, reporter: Me, typed: string, category: string, text: string, found: Candidate[],
): InteractionReply {
  const reporterId = reporter.kind === 'player' ? reporter.steamid : null;
  const reporterDiscordId = reporter.kind === 'discord' ? reporter.discordId : null;
  // Only the newest draft is ever useful: opening the form again means the
  // reporter is trying once more, and a stale draft's candidate buttons
  // already answer "expired" once it is gone, so nothing is lost by clearing
  // it early. This bounds the table at one row per reporter, which is a
  // resource bound, not a policy check: it must stay that, so nobody later
  // "upgrades" it into a banned/good-standing gate. That check belongs to
  // fileReport alone, which this path never reaches.
  deps.db.prepare('DELETE FROM pending_reports WHERE reporter_id IS ? AND reporter_discord_id IS ?').run(reporterId, reporterDiscordId);
  const id = Number(deps.db.prepare(
    'INSERT INTO pending_reports (reporter_id, reporter_discord_id, category, text, typed_name, candidates, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(reporterId, reporterDiscordId, category, text, typed, JSON.stringify(found.map((c) => c.steamid)),
    (deps.now?.() ?? new Date()).toISOString()).lastInsertRowid);
  return say(
    `More than one player is called "${typed}". Which one do you mean? Nothing is filed until you choose.`,
    [found.map((c) => ({ kind: 'button' as const, customId: `${REPORT_PREFIX}pick:${id}:${c.steamid}`, label: clip(c.name), style: 'secondary' as const }))],
  );
}
