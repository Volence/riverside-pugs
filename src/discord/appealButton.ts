import { createHash } from 'node:crypto';
import type { DB } from '../db.js';
import { getSetting } from '../settings.js';
import { activeTargets, appealSettings, appellantFromDiscord, judge, parseRefKey, refKey, refusalText } from '../appeals/rules.js';
import { fileAppeal } from '../appeals/store.js';
import type { Appealable } from '../appeals/types.js';
import type { BotInteraction, BotTransport, InteractionReply, MessagePayload, ModalDef, ModalField } from './transport.js';

/** Custom id prefix. 'rp:' is the Report button beside it. */
export const APPEAL_PREFIX = 'ap:';

export function opensAppealModal(customId: string): boolean {
  return customId === `${APPEAL_PREFIX}open`;
}

const say = (content: string): InteractionReply => ({ ephemeral: true, payload: { content, embeds: [], components: [] } });
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

function describe(t: Appealable): string {
  if (t.hold) return 'Account hold';
  if (t.sanctionKind) return clip(`Discord ${t.sanctionKind}: ${t.reason}`, 100);
  return clip(`Ban: ${t.reason}`, 100);
}

function standingPayload(publicUrl: string): MessagePayload {
  return {
    content: [
      '**Banned, on hold or timed out?**',
      '',
      'If you think it was a mistake, press Appeal and tell the staff what happened.',
      'You get one appeal at a time. Staff may write back with questions, and you can reply on the site.',
      '',
      `Banned from this Discord? Appeal at ${publicUrl}/appeal`,
    ].join('\n'),
    embeds: [],
    components: [[{ kind: 'button', customId: `${APPEAL_PREFIX}open`, label: 'Appeal', style: 'secondary' }]],
  };
}

const hashOf = (p: MessagePayload) => createHash('sha256').update(JSON.stringify(p)).digest('hex').slice(0, 16);

/** One standing message in the Report button's channel, while appeals are on. */
export class AppealButton {
  private timer: NodeJS.Timeout | null = null;

  constructor(private deps: { db: DB; transport: BotTransport; publicUrl: string; intervalMs?: number; now?: () => Date }) {}

  start(): void {
    void this.tick();
    const every = this.deps.intervalMs ?? 5 * 60_000;
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
      console.error('[discord] appeal button:', err);
    }
  }

  private async ensureMessage(): Promise<void> {
    const { db, transport } = this.deps;
    const on = getSetting(db, 'appeals_enabled') === '1';
    const channelId = on ? getSetting(db, 'discord_report_channel_id') ?? '' : '';
    const row = db.prepare('SELECT channel_id, message_id, hash FROM appeal_message WHERE id = 1')
      .get() as { channel_id: string; message_id: string; hash: string } | undefined;
    if (!channelId) {
      if (row) {
        await transport.remove(row.channel_id, row.message_id).catch(() => {});
        db.prepare('DELETE FROM appeal_message WHERE id = 1').run();
      }
      return;
    }
    const payload = standingPayload(this.deps.publicUrl);
    const hash = hashOf(payload);
    if (row && row.channel_id !== channelId) {
      await transport.remove(row.channel_id, row.message_id).catch(() => {});
    } else if (row && row.hash === hash) {
      if (await transport.edit(row.channel_id, row.message_id, payload)) return;
    } else if (row) {
      if (await transport.edit(row.channel_id, row.message_id, payload)) { this.remember(channelId, row.message_id, hash); return; }
    }
    const messageId = await transport.send(channelId, payload);
    this.remember(channelId, messageId, hash);
  }

  private remember(channelId: string, messageId: string, hash: string): void {
    this.deps.db.prepare(
      `INSERT INTO appeal_message (id, channel_id, message_id, hash, updated_at) VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET channel_id = excluded.channel_id, message_id = excluded.message_id,
         hash = excluded.hash, updated_at = excluded.updated_at`,
    ).run(channelId, messageId, hash, (this.deps.now?.() ?? new Date()).toISOString());
  }
}

interface HandlerDeps { db: DB; publicUrl: string; now?: () => Date }

/** Answered before the press is deferred (opensModal), so a quick read only. */
export async function handleAppealButton(deps: HandlerDeps, i: Extract<BotInteraction, { kind: 'button' }>): Promise<InteractionReply> {
  if (i.customId !== `${APPEAL_PREFIX}open`) return say('That button no longer does anything.');
  const now = deps.now?.() ?? new Date();
  const s = appealSettings(deps.db);
  if (!s.enabled) return say(refusalText({ ok: false, reason: 'disabled' }));
  const who = appellantFromDiscord(deps.db, i.userId, i.userName);
  const targets = activeTargets(deps.db, who, now);
  if (targets.length === 0) return say(refusalText({ ok: false, reason: 'nothing_to_appeal' }));
  const verdicts = targets.map((t) => judge(deps.db, t, now));
  const ok = targets.filter((_, n) => verdicts[n].ok);
  if (ok.length === 0) {
    const first = verdicts.find((v) => !v.ok) as Extract<ReturnType<typeof judge>, { ok: false }>;
    return say(refusalText(first));
  }
  const max = Math.min(s.textMax, 4000);
  const fields: ModalField[] = [
    { kind: 'text', id: 'what', label: 'What happened?', style: 'paragraph', required: true, maxLength: max },
    { kind: 'text', id: 'why', label: 'Why should it be lifted or shortened?', style: 'paragraph', required: true, maxLength: max },
  ];
  const modal: ModalDef = ok.length === 1
    ? { customId: `${APPEAL_PREFIX}new:${refKey(ok[0].ref)}`, title: 'Appeal', fields }
    : {
        customId: `${APPEAL_PREFIX}new`, title: 'Appeal',
        fields: [
          { kind: 'select', id: 'which', label: 'Which one?', options: ok.slice(0, 25).map((t, n) => ({ label: describe(t), value: refKey(t.ref), ...(n === 0 ? { default: true } : {}) })) },
          ...fields,
        ],
      };
  return { ephemeral: true, payload: { content: 'Opening the form...', embeds: [], components: [] }, modal };
}

/** The ref in the custom id (or the select) travels through Discord, so it
 *  is only a claim: fileAppeal accepts it only if it is one of this
 *  member's own bans. */
export async function handleAppealModal(deps: HandlerDeps, i: Extract<BotInteraction, { kind: 'modal' }>): Promise<InteractionReply> {
  const fromId = i.customId.startsWith(`${APPEAL_PREFIX}new:`) ? i.customId.slice(`${APPEAL_PREFIX}new:`.length) : (i.fields.which ?? '');
  const ref = parseRefKey(fromId);
  if (!ref) return say('Pick what you are appealing.');
  const who = appellantFromDiscord(deps.db, i.userId, i.userName);
  const r = fileAppeal(deps.db, who, { ref, whatHappened: i.fields.what, whyLift: i.fields.why, source: 'discord_button' }, deps.now?.());
  if (!r.ok) return say(r.error);
  if (r.state === 'auto_denied') return say('Your appeal was denied automatically because it contains a slur.');
  return say(`Your appeal was sent. Staff will look at it, and the bot will DM you when there is news. You can also follow it at ${deps.publicUrl}/appeal`);
}
