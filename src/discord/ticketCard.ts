import { createHash } from 'node:crypto';
import type { DB } from '../db.js';
import { getPlayer } from '../players.js';
import { targetLabel } from '../tickets/person.js';
import { getTicketRow } from '../tickets/store.js';
import { reporterThreadsOf } from '../tickets/reporterChat.js';
import { TICKET_OUTCOMES } from '../tickets/actions.js';
import { escapeName } from './presenter.js';
import type { ActionRow, Button, EmbedField, MessagePayload, ModalDef } from './transport.js';

/** The Chat button a reporter sees: on the receipt, and in My reports. Keyed
 *  by the REPORT: a ticket id would let two reporters learn they reported
 *  the same case. */
export function chatButton(reportId: number, label = 'Chat with the moderators'): Button {
  return { kind: 'button', customId: `rp:chat:${reportId}`, label: label.slice(0, 80), style: 'secondary' };
}

const COLOR = { open: 0xde4e40, claimed: 0xc9a45c, closed: 0x8a7f73 };
const OUTCOME_LABEL: Record<(typeof TICKET_OUTCOMES)[number], string> = {
  action_taken: 'Action taken', warned: 'Warned', no_action: 'No action', invalid: 'Invalid report',
};

export interface TicketCard {
  /** The thread's title. Used when the thread is made and never again. */
  name: string;
  payload: MessagePayload;
  /** Tag NAMES: the status, then up to four categories. */
  tags: string[];
  /** Of the payload and the tags: what decides whether Discord needs telling. */
  hash: string;
}

interface ReportBit { id: number; category: string; match_id: number | null; map_ordinal: number | null; half: number | null; t_ms: number | null }

const people = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`;

function matchLinks(r: ReportBit, publicUrl: string): string {
  const match = `[match #${r.match_id}](${publicUrl}/match/${r.match_id})`;
  if (r.map_ordinal === null || r.half === null || r.t_ms === null) return match;
  return `${match} · [replay moment](${publicUrl}/match/${r.match_id}?ordinal=${r.map_ordinal}&half=${r.half}&t=${r.t_ms})`;
}

/**
 * The case card: the first message of a ticket's staff thread.
 *
 * It names the accused and nobody else. Who reported, and what they wrote,
 * stay on the ticket page behind canSeeTicket; the card links there.
 */
export function ticketCard(db: DB, ticketId: number, publicUrl: string): TicketCard | null {
  const t = getTicketRow(db, ticketId);
  if (!t) return null;
  const reports = db.prepare(
    'SELECT id, category, match_id, map_ordinal, half, t_ms FROM ticket_reports WHERE ticket_id = ? ORDER BY id',
  ).all(ticketId) as ReportBit[];
  const reporters = (db.prepare(
    "SELECT COUNT(DISTINCT COALESCE(reporter_id, 'd:' || reporter_discord_id)) AS n FROM ticket_reports WHERE ticket_id = ?",
  ).get(ticketId) as { n: number }).n;
  const categories = [...new Set(reports.map((r) => r.category))];
  const accused = targetLabel(db, t);
  const url = `${publicUrl}/admin/people/tickets/${t.id}`;
  const status = t.status === 'closed' ? 'closed' : t.claimed_by ? 'claimed' : 'open';
  const claimedBy = t.claimed_by ? escapeName(getPlayer(db, t.claimed_by)?.name ?? t.claimed_by) : '';
  // A Discord-only person has no profile page. The id is shown as code so a
  // moderator can find them in Discord's member list; never as a mention,
  // which would ping them from a staff post.
  const accusedValue = t.target_id !== null
    ? `${escapeName(accused)} ([profile](${publicUrl}/player/${t.target_id}))`
    : `${escapeName(accused)} (Discord member \`${t.target_discord_id}\`)`;

  const fields: EmbedField[] = [
    // A player name is never anchor text: Steam allows [ ] ( ) in a name,
    // which escapeName does not neutralise, and a name used as the link's
    // own text could break out and point the link somewhere else. The name
    // sits as plain escaped text; the link's anchor is the fixed word
    // "profile" and its target holds nothing but publicUrl and the steamid.
    { name: 'Accused', value: accusedValue, inline: true },
    {
      name: 'Status', inline: true,
      value: status === 'closed' ? `closed: ${(t.outcome ?? '').replace(/_/g, ' ')}` : status === 'claimed' ? `claimed by ${claimedBy}` : 'open, unclaimed',
    },
    { name: 'Reports', value: reports.length === 0 ? 'None. Opened by staff.' : `${reports.length} from ${people(reporters)}: ${categories.join(', ')}` },
  ];
  const withMatch = reports.filter((r) => r.match_id !== null).slice(-5);
  if (withMatch.length > 0) fields.push({ name: 'Matches', value: withMatch.map((r) => matchLinks(r, publicUrl)).join('\n') });

  // Row one: Claim, Close, the link. Row two, while open: Contact reporter
  // when anyone reported, and Join and End while a chat is open.
  const openChats = reporterThreadsOf(db, t.id, 'open').length;
  const chatRow: ActionRow = [];
  if (t.status === 'open' && reports.length > 0) chatRow.push({ kind: 'button', customId: `t:${t.id}:contact`, label: 'Contact reporter', style: 'secondary' });
  if (t.status === 'open' && openChats > 0) {
    chatRow.push({ kind: 'button', customId: `t:${t.id}:join`, label: 'Join reporter chat', style: 'secondary' });
    chatRow.push({ kind: 'button', customId: `t:${t.id}:endchat`, label: 'End reporter chat', style: 'secondary' });
  }
  const row: ActionRow = t.status === 'open'
    ? [
      { kind: 'button', customId: `t:${t.id}:claim`, label: t.claimed_by ? 'Release' : 'Claim', style: t.claimed_by ? 'secondary' : 'primary' },
      { kind: 'button', customId: `t:${t.id}:close`, label: 'Close', style: 'danger' },
      { kind: 'link', url, label: 'Open on the site' },
    ]
    : [{ kind: 'link', url, label: 'Open on the site' }];

  const payload: MessagePayload = {
    embeds: [{
      title: `Ticket #${t.id}`,
      url,
      description: 'Who reported and what they wrote is on the ticket page. Bans are issued there too.',
      color: COLOR[status],
      fields,
      footer: t.restricted === 1
        ? 'Restricted. Anyone with the Discord Administrator permission can read this thread.'
        : undefined,
    }],
    components: chatRow.length > 0 ? [row, chatRow] : [row],
    mentionUserIds: [],
  };
  const tags = [status, ...categories.slice(0, 4)];
  const what = categories.length > 0 ? categories.join(', ') : 'opened by staff';
  return {
    // A restricted thread's title says nothing: titles surface in places
    // (search, audit log, notifications) that the thread's content does not.
    name: (t.restricted === 1 ? `Ticket #${t.id}` : `#${t.id} ${accused} (${what})`).slice(0, 100),
    payload,
    tags,
    hash: createHash('sha1').update(JSON.stringify([payload, tags])).digest('hex'),
  };
}

/** The line a further report posts into the thread. The category and where to
 *  look, never who filed it or what they wrote. */
export function reportLine(db: DB, reportId: number, publicUrl: string): MessagePayload {
  const r = db.prepare(
    'SELECT id, category, match_id, map_ordinal, half, t_ms FROM ticket_reports WHERE id = ?',
  ).get(reportId) as ReportBit;
  const where = r.match_id === null ? '' : ` · ${matchLinks(r, publicUrl)}`;
  return {
    embeds: [{ description: `Another report: **${r.category}**${where}`, color: COLOR.open }],
    components: [],
    mentionUserIds: [],
  };
}

/** What the Close button opens. The outcome is a pick, the note is free. */
export function closeModal(ticketId: number): ModalDef {
  return {
    customId: `t:${ticketId}:close`,
    title: `Close ticket #${ticketId}`,
    fields: [
      { kind: 'select', id: 'outcome', label: 'Outcome', options: TICKET_OUTCOMES.map((o) => ({ label: OUTCOME_LABEL[o], value: o })) },
      { kind: 'text', id: 'note', label: 'Note (staff only)', style: 'paragraph', required: false, maxLength: 1000 },
      { kind: 'select', id: 'tell', label: 'Tell the reporters it is closed?', options: [
        { label: 'Yes, send them a thank-you', value: 'yes', default: true },
        { label: 'No', value: 'no' },
      ] },
    ],
  };
}

/** Sent once to each person on a restricted ticket's access list. It names
 *  nobody: the link does the telling, behind the site's own access check. */
export function accessDm(ticketId: number, publicUrl: string): MessagePayload {
  const url = `${publicUrl}/admin/people/tickets/${ticketId}`;
  return {
    content: [
      'You have been given access to a restricted ticket. Only the people on its access list can see it.',
      'Restricted tickets are worked on the site only, with no Discord thread, so keep the discussion there.',
    ].join('\n'),
    embeds: [],
    components: [[{ kind: 'link', url, label: `Open ticket #${ticketId}` }]],
    mentionUserIds: [],
  };
}

/** The neutral DM a reporter gets when their ticket closes, if the closer
 *  left the tick on. It says nothing about the outcome. */
export function closeDm(): MessagePayload {
  return { content: 'Thank you for your report. The ticket is now closed.', embeds: [], components: [], mentionUserIds: [] };
}

/** To the access list of a restricted ticket, once for whatever the reporter
 *  did in their chat since the last one: opened it, wrote in it, or both.
 *  The wording has to hold for either, so it says "activity", not "wrote":
 *  a DM sent because the reporter only opened the chat must not claim they
 *  said something. No words of theirs and no name either way: the link does
 *  the telling, behind the site's own access check. */
export function reporterWroteDm(ticketId: number, publicUrl: string): MessagePayload {
  return {
    content: `There is new activity from the reporter on ticket #${ticketId}. Read it on the site.`,
    embeds: [],
    components: [[{ kind: 'link', url: `${publicUrl}/admin/people/tickets/${ticketId}`, label: `Open ticket #${ticketId}` }]],
    mentionUserIds: [],
  };
}
