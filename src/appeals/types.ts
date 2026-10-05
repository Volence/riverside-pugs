/**
 * Shared shapes for ban appeals (spec docs/superpowers/specs/2026-10-04-ban-appeals-design.md).
 * A leaf: imports nothing from the rest of src/appeals, so every other
 * appeals module can import it without a cycle.
 */

/** What an appeal is about: a row in `bans` (a website ban or an alt hold)
 *  or a row in `discord_sanctions` (a bot-run Discord timeout or ban). */
export type AppealRef = { kind: 'ban'; id: number } | { kind: 'sanction'; id: number };

export type AppealState =
  | 'open' | 'asked' | 'answered'
  | 'accepted' | 'shortened' | 'denied' | 'auto_denied' | 'lapsed' | 'moot';

/** Still waiting on someone. Everything else is settled. */
export const OPEN_STATES: readonly AppealState[] = ['open', 'asked', 'answered'];

/** Count as a turned-down appeal: they start the cooldown. */
export const DENIAL_STATES: readonly AppealState[] = ['denied', 'auto_denied', 'lapsed'];

export type AppealSource = 'site' | 'discord_button' | 'appeal_page';

/** One `appeals` row as SQLite returns it. */
export interface AppealRow {
  id: number;
  ban_id: number | null;
  sanction_id: number | null;
  steamid: string | null;
  discord_id: string | null;
  appellant_name: string;
  what_happened: string;
  why_lift: string;
  state: AppealState;
  question: string | null;
  asked_by: string | null;
  asked_at: string | null;
  answer: string | null;
  answered_at: string | null;
  decided_by: string | null;
  decided_at: string | null;
  new_expires_at: string | null;
  slurs: string | null;
  source: AppealSource;
  created_at: string;
  forum_thread_id: string | null;
  forum_message_id: string | null;
  forum_state: string | null;
  dm_state: string | null;
}

/** Who is appealing. `steamids`: every player account this person may speak
 *  for (one for a Steam session; for a Discord identity, each account linked
 *  to it now or before). `discordId`: their Discord, when known. */
export interface Appellant {
  steamids: string[];
  discordId: string | null;
  name: string;
}

/** One ban, hold or Discord sanction in force against an appellant. */
export interface Appealable {
  ref: AppealRef;
  /** The banned player (bans only). */
  steamid: string | null;
  /** The sanctioned Discord id (sanctions only). */
  discordId: string | null;
  reason: string;
  createdBy: string;
  createdAt: string;
  endsAt: string | null;
  hold: boolean;
  sanctionKind: 'timeout' | 'ban' | null;
  ticketId: number | null;
  noAppeal: boolean;
}

export const refColumn = (ref: AppealRef): 'ban_id' | 'sanction_id' => (ref.kind === 'ban' ? 'ban_id' : 'sanction_id');
export const sameRef = (a: AppealRef, b: AppealRef): boolean => a.kind === b.kind && a.id === b.id;
export const refOf = (row: Pick<AppealRow, 'ban_id' | 'sanction_id'>): AppealRef =>
  (row.ban_id !== null ? { kind: 'ban', id: row.ban_id } : { kind: 'sanction', id: row.sanction_id! });
