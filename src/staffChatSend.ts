import type { DB } from './db.js';
import type { LeaseRcon } from './practiceLeases.js';
import { getServer } from './serverPool.js';
import { recordStaffOut } from './serverChat.js';

/**
 * Staff messages into a game server. The ONLY command built from user text is
 * sm_pug_staffsay, and the text goes in as two quoted arguments with every
 * character that could end a quote or start a second console command
 * (`"`, `;`, a line break) turned into a space first.
 */

export type SendTarget = { to: 'all' } | { to: 'team'; team: 1 | 2 | 3 } | { to: 'player'; steamid: string };
export type SendResult = { ok: true; id: number } | { ok: false; id: number; error: string };

export const NAME_MAX = 32;
export const MESSAGE_MAX = 190;

export function cleanChatText(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/["\r\n;]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
}

export class SendLimiter {
  private sent = new Map<string, number[]>();
  constructor(private max = 5, private windowMs = 10_000) {}
  allow(steamid: string, now = Date.now()): boolean {
    const recent = (this.sent.get(steamid) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) { this.sent.set(steamid, recent); return false; }
    recent.push(now);
    this.sent.set(steamid, recent);
    return true;
  }
}

const TEAM_WORD = { 1: 'spectators', 2: 'survivors', 3: 'infected' } as const;

/**
 * The one place a console command is assembled from user text. It cleans its
 * own inputs rather than trusting a caller to have run cleanChatText first,
 * so the spec's guarantee (a message with `"; quit` or a line break never
 * becomes a second console command) holds here regardless of what callers do.
 */
export function staffSayCommand(target: SendTarget, name: string, message: string, sendId: number): string {
  if (target.to === 'player' && !/^\d{17}$/.test(target.steamid)) {
    throw new Error('staffSayCommand: bad SteamID64');
  }
  const to = target.to === 'all' ? 'all' : target.to === 'team' ? TEAM_WORD[target.team] : target.steamid;
  const safeName = cleanChatText(name, NAME_MAX) || 'Staff';
  const safeMessage = cleanChatText(message, MESSAGE_MAX);
  return `sm_pug_staffsay ${to} "${safeName}" "${safeMessage}" ${sendId}`;
}

export async function sendStaffChat(
  db: DB, rcon: LeaseRcon,
  input: { serverId: number; sentBy: string; name: string; target: SendTarget; message: string },
): Promise<SendResult> {
  const { target } = input;
  const id = recordStaffOut(db, input.serverId, {
    sentBy: input.sentBy, name: input.name, toKind: target.to,
    toValue: target.to === 'team' ? String(target.team) : target.to === 'player' ? target.steamid : null,
    message: input.message,
  });
  const failed = (error: string): SendResult => {
    db.prepare('UPDATE server_chat SET delivered = -1 WHERE id = ?').run(id);
    return { ok: false, id, error };
  };
  const server = getServer(db, input.serverId);
  if (!server) return failed('No such server.');
  let command: string;
  try {
    command = staffSayCommand(target, input.name, input.message, id);
  } catch (err) {
    console.error(`[serverchat] send ${id} built a bad command:`, err);
    return failed('Bad whisper target.');
  }
  let reply: string;
  try {
    [reply = ''] = await rcon(server, [command]);
  } catch (err) {
    console.error(`[serverchat] send ${id} to ${server.name} failed:`, err);
    return failed('Could not reach the server.');
  }
  if (/Unknown command/i.test(reply)) return failed('This server needs pug-match 0.3.16 to send.');
  return { ok: true, id };
}
