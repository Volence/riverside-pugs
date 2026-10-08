// src/events/draftRoomView.ts
import type { DB } from '../db.js';
import { getPlayer } from '../players.js';
import { pairChemistry, type PairChemistry } from '../chemistry.js';
import * as E from './events.js';
import * as D from './drafts.js';
import * as DR from './draftRoom.js';
import { roomSettingsOf, type RoomSettings } from './draftRules.js';
import type { PlayerCard } from './draftCards.js';

/**
 * GET /api/events/:slug/draft, tailored per viewer (drafts plan D2b1
 * Rulings 10, 14, 16, 22). Everyone: status, settings, the clock (with the
 * server's now for skew), order, the pick log without undone picks, teams so
 * far and the free pool as public cards. The team's captain also gets that team's
 * list; the captain or delegate gets the notes and chemistry with themselves. Staff and
 * the organizer get every list and the notes. Fairness is never here: it
 * stays on the desk's Make teams panel.
 */
export interface RoomViewer { steamid: string | null; staff: boolean }
export interface DraftPickView { pickNo: number; round: number; captain: string; steamid: string; name: string; auto: boolean; at: string }
export interface DraftRoomView {
  eventId: number; slug: string; eventName: string;
  status: 'none' | DR.RoomStatus; teamsMadeAt: string | null; settings: RoomSettings;
  serverNow: string; deadlineAt: string | null; pausedLeftMs: number | null; totalPicks: number;
  order: { steamid: string; name: string }[];
  onClock: { pickNo: number; round: number; captain: string; picker: string } | null;
  picks: DraftPickView[];
  delegates: Record<string, string>;
  teams: { captain: { steamid: string; name: string }; players: { steamid: string; name: string }[] }[];
  pool: PlayerCard[];
  notes: Record<string, string> | null;
  me: { role: 'captain' | 'delegate' | null; team: string | null; onClock: boolean; list: string[] | null; chemistry: Record<string, PairChemistry> | null };
  lists: Record<string, string[]> | null;
  staff: boolean;
}

/** Signup notes by player, for the pool only. */
export function notesFor(pool: D.SignupRow[]): Record<string, string> {
  return Object.fromEntries(pool.filter((s) => s.note !== null).map((s) => [s.steamid, s.note!]));
}

/** The viewer's chemistry with each pool player; never with themselves
 *  (pairChemistry(a, a) would self-join). */
export function chemistryFor(db: DB, viewer: string, pool: D.SignupRow[]): Record<string, PairChemistry> {
  return Object.fromEntries(pool.filter((s) => s.steamid !== viewer).map((s) => [s.steamid, pairChemistry(db, viewer, s.steamid)]));
}

export function draftRoomView(db: DB, ev: E.EventRow, viewer: RoomViewer, now: Date, cardsOf: (steamids: string[]) => PlayerCard[]): DraftRoomView {
  const live = ev.team_mode === 'live';
  const st = live ? DR.roomState(db, ev.id) : null;
  const room = st?.room ?? null;
  const status: DraftRoomView['status'] = !live ? 'none' : room?.status ?? 'ready';
  const all = D.activeSignups(db, ev.id);
  const captains = all.filter((s) => s.role === 'captain');
  const pool = all.filter((s) => s.role === 'pool');
  const nameOf = (s: string) => getPlayer(db, s)?.name ?? s;
  const order = st && st.order.length > 0 ? st.order : captains.map((c) => c.steamid);
  const picks = st?.picks ?? [];
  const delegates = st?.delegates ?? {};
  const taken = new Set(picks.map((p) => p.steamid));
  const me = viewer.steamid;
  const team = me !== null ? DR.captainFor(db, ev.id, me) : null;
  const role: 'captain' | 'delegate' | null = team === null ? null : team === me ? 'captain' : 'delegate';
  const seeAll = viewer.staff || (me !== null && me === ev.organizer_steamid);
  const settings = roomSettingsOf(ev.draft_json);
  return {
    eventId: ev.id, slug: ev.slug, eventName: ev.name, status, teamsMadeAt: ev.teams_made_at,
    settings: room && room.status !== 'ready' ? { ...settings, pickSeconds: room.pick_seconds } : settings,
    serverNow: now.toISOString(),
    deadlineAt: status === 'running' ? room!.deadline_at : null,
    pausedLeftMs: status === 'paused' ? room!.paused_left_ms : null,
    totalPicks: pool.length,
    order: order.map((s) => ({ steamid: s, name: nameOf(s) })),
    onClock: status === 'running' && st?.next ? { pickNo: st.next.pickNo, round: st.next.round, captain: st.next.captain, picker: st.picker! } : null,
    picks: picks.map((p) => ({ pickNo: p.pick_no, round: p.round, captain: p.captain_steamid, steamid: p.steamid, name: nameOf(p.steamid), auto: p.auto === 1, at: p.at })),
    delegates,
    teams: order.map((c) => ({
      captain: { steamid: c, name: nameOf(c) },
      players: picks.filter((p) => p.captain_steamid === c).map((p) => ({ steamid: p.steamid, name: nameOf(p.steamid) })),
    })),
    pool: cardsOf(pool.filter((s) => !taken.has(s.steamid)).map((s) => s.steamid)),
    notes: seeAll || team !== null ? notesFor(pool) : null,
    me: {
      role,
      team,
      onClock: me !== null && status === 'running' && st?.picker === me,
      // Ruling P4: only the captain reads the list; a delegate picks without it.
      list: role === 'captain' ? DR.pickListOf(db, ev.id, team!) : null,
      chemistry: team !== null && me !== null ? chemistryFor(db, me, pool) : null,
    },
    lists: seeAll ? Object.fromEntries(captains.map((c) => [c.steamid, DR.pickListOf(db, ev.id, c.steamid)])) : null,
    staff: seeAll,
  };
}
