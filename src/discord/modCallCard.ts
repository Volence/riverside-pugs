import type { DB } from '../db.js';
import { discordLabel, escapeName, identityOf } from '../identity.js';
import { foldedCalls, REASON_LABELS, type ModCallRow } from '../modCalls.js';
import { getSetting } from '../settings.js';
import { spectateFor } from '../spectate.js';
import { spectateConnectLine } from './controller.js';
import type { ActionRow, MessagePayload } from './transport.js';

export const MOD_CALL_PREFIX = 'mc:';
const COLOR = 0xde4e40;
/** Discord refuses an embed whose description is longer than this, and a
 *  refused card would sit in the retry pass until it aged out. */
const DESCRIPTION_MAX = 4096;

/**
 * The description, with as many folded-call lines as fit. A pile-on of calls
 * in five minutes can outgrow Discord's limit; the head (who, about, where)
 * and the tail (watch, handled) always stay, and the calls that do not fit
 * are counted instead, since the site lists every one.
 */
function fit(head: string[], children: string[], tail: string[]): string {
  const join = (shown: number) => {
    const more = children.length - shown;
    const rest = more > 0 ? [`+ ${more} more on the site`] : [];
    return [...head, ...children.slice(0, shown), ...rest, ...tail].join('\n');
  };
  let shown = children.length;
  let text = join(shown);
  while (text.length > DESCRIPTION_MAX && shown > 0) text = join(--shown);
  return text.length > DESCRIPTION_MAX ? text.slice(0, DESCRIPTION_MAX) : text;
}

/**
 * The admin channel card for one in-game call and every call folded into it.
 *
 * Pure: it reads the database and returns the payload, and the poster decides
 * when to send or edit. Everything a player typed or is named is escaped, and
 * the only mention the payload permits is the mod call role, so a name like
 * "@everyone" or "<@123>" in a caller's text is shown and never pings. Caller
 * and target show as <@id> so staff can click through, but mentionUserIds
 * stays empty: nobody named on the card is notified by it.
 */
export function renderModCallCard(db: DB, call: ModCallRow, publicUrl: string): MessagePayload {
  const children = foldedCalls(db, call.id);
  const handled = call.handled_at !== null;
  const who = (steamid: string) => discordLabel(identityOf(db, steamid));
  const ticketUrl = call.ticket_id !== null ? `${publicUrl}/admin/people/tickets/${call.ticket_id}` : null;

  const lines: string[] = [];
  lines.push(`Caller: ${who(call.caller_steamid)}${call.via === 'tv' ? ' on SourceTV' : ''}`);
  if (call.target_kind === 'player' && call.target_steamid) lines.push(`About: ${who(call.target_steamid)}`);
  else if (call.target_kind === 'team') lines.push('About: their own team');
  else if (call.target_kind === 'general') lines.push('About: the whole server');

  const server = call.server_id !== null
    ? (db.prepare('SELECT name FROM servers WHERE id = ?').get(call.server_id) as { name: string } | undefined)
    : undefined;
  let where = `Server: ${escapeName(server?.name ?? 'unknown')}`;
  if (call.map) where += ` · ${escapeName(call.map)}`;
  if (call.match_id !== null) where += ` · match [#${call.match_id}](${publicUrl}/match/${call.match_id})`;
  lines.push(where);

  if (call.text.trim() !== '') lines.push(call.text.split('\n').map((l) => `> ${escapeName(l)}`).join('\n'));
  if (ticketUrl) lines.push(`Ticket [#${call.ticket_id}](${ticketUrl})`);
  // The note says why there is no ticket, or that the rate cap held back the
  // ping; it can sit beside a ticket, so it is not an either/or.
  if (call.note) lines.push(escapeName(call.note));

  const childLines = children.map((c) => {
    const said = c.text.trim() !== '' ? ` "${escapeName(c.text)}"` : '';
    return `+ ${who(c.caller_steamid)}: ${REASON_LABELS[c.reason]}${said}`;
  });

  // Watching is the fastest way to judge a cheating call, so the connect line
  // rides on the card rather than behind a button.
  const tv = spectateFor(db, call.server_id);
  const tail: string[] = [];
  if (tv) tail.push(`Watch: \`${spectateConnectLine(tv)}\``);
  if (handled && call.handled_by_discord_id) tail.push(`Handled by <@${call.handled_by_discord_id}>`);

  const row: ActionRow = [{
    kind: 'button', customId: `${MOD_CALL_PREFIX}${call.id}:handle`,
    label: handled ? 'Handled' : 'Handling it', style: 'success', disabled: handled,
  }];
  if (call.match_id !== null && call.map_ordinal !== null && call.half !== null && call.t_ms !== null) {
    row.push({
      kind: 'link', label: 'Replay moment',
      url: `${publicUrl}/match/${call.match_id}?ordinal=${call.map_ordinal}&half=${call.half}&t=${call.t_ms}`,
    });
  }
  if (ticketUrl) row.push({ kind: 'link', label: 'Ticket', url: ticketUrl });

  const role = getSetting(db, 'mod_call_role_id') ?? '';
  const ping = call.pinged === 1 && role !== '';
  const title = `In-game call: ${REASON_LABELS[call.reason]}${children.length > 0 ? ` (${children.length + 1} calls)` : ''}`;
  return {
    ...(ping ? { content: `<@&${role}>` } : {}),
    embeds: [{ title, color: COLOR, description: fit(lines, childLines, tail) }],
    components: [row],
    mentionUserIds: [],
    mentionRoleIds: ping ? [role] : [],
  };
}
