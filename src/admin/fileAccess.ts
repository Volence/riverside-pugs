import type { DB } from '../db.js';
import { resolveAlias } from '../aliases.js';
import { getPlayer } from '../players.js';
import { hasStaffFlag } from '../tickets/store.js';

/**
 * One place that decides what a viewer may open and do on a Player File.
 *
 * The API asks this and the UI only hides what it would refuse, so a control
 * that should not be there is a cosmetic bug rather than a hole. A file the
 * viewer may not open is a 404 at the route, never a 403: who is staff and
 * who has a file open about them is not something to leak by status code.
 */
export interface FileViewer {
  steamid: string;
  isAdmin: boolean;
  isMod: boolean;
}

export function fileViewer(db: DB, steamid: string): FileViewer {
  const p = getPlayer(db, steamid);
  return { steamid, isAdmin: p?.is_admin === 1, isMod: p?.is_mod === 1 };
}

/**
 * Admins open any file. Moderators open any file except their own and the
 * files of other staff: a moderator reading the evidence gathered about a
 * colleague, or about themselves, is the case the tickets work already keeps
 * apart, and the file is the same information in one place.
 *
 * Aliases are resolved on both sides, so neither a merged second account of
 * the viewer nor of the target is a way round the rule.
 */
export function canOpenFile(db: DB, viewer: FileViewer, targetSteamid: string): boolean {
  if (!viewer.isAdmin && !viewer.isMod) return false;
  if (viewer.isAdmin) return true;
  const target = resolveAlias(db, targetSteamid);
  if (target === resolveAlias(db, viewer.steamid)) return false;
  // hasStaffFlag ignores status on purpose: a banned moderator is still a
  // colleague for the purpose of keeping the others out of their file.
  return !hasStaffFlag(db, target);
}

/** Everything a file offers. `waive` has no route yet: it belongs to the
 *  Live work, which adds waiving an automatic penalty or abandon ban, and it
 *  is listed here so the Standing section has one name to ask about.
 *  `review_round` marks a round reviewed from the replay analyzer; it is
 *  admin-only so that control comes from an explicit permission rather than
 *  the viewer inferring "this is an admin" from `actions.includes('ban')`. */
export type FileAction =
  | 'note' | 'looked_at' | 'open_ticket'
  | 'ban' | 'timeout' | 'merge' | 'sign_out' | 'waive' | 'staff_flags' | 'review_round';

/** A moderator writes a note, marks a file looked at, and opens a ticket. A
 *  moderator bans only from a ticket and only up to the configured cap,
 *  which is the tickets route and is not reachable from here. */
const MOD_ACTIONS: FileAction[] = ['note', 'looked_at', 'open_ticket'];
const ADMIN_ACTIONS: FileAction[] = [
  ...MOD_ACTIONS, 'ban', 'timeout', 'merge', 'sign_out', 'waive', 'staff_flags', 'review_round',
];

export function fileActions(db: DB, viewer: FileViewer, target: string): FileAction[] {
  if (!canOpenFile(db, viewer, target)) return [];
  return viewer.isAdmin ? ADMIN_ACTIONS : MOD_ACTIONS;
}

export function canDo(db: DB, viewer: FileViewer, target: string, action: FileAction): boolean {
  return fileActions(db, viewer, target).includes(action);
}
