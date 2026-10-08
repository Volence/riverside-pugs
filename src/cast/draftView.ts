import type { DB } from '../db.js';
import { currentSeasonId } from '../players.js';
import * as E from '../events/events.js';
import { draftRoomView } from '../events/draftRoomView.js';
import { playerCard, type PlayerCard } from '../events/draftCards.js';
import { ROUNDS, snakeSlots } from '../events/draftRules.js';
import { BEST_AVAILABLE, type CastDraftCard, type CastDraftPlayer, type CastDraftView } from './types.js';

/**
 * The draft as the overlays get it (drafts plan D2b2 Ruling 3). Built from
 * D2b1's room view for the anonymous viewer and then copied field by field,
 * so nothing private can ride along whoever the caster is: no note, no pick
 * list, no chemistry, no fairness, no `me`, `lists`, `notes` or `delegates`,
 * and no SR trend or skill counters (no room on a broadcast card).
 */

/** Ruling 9: D2b1's 60 s card memo, kept here because the room route's is private. */
export const CARD_TTL_MS = 60_000;
export type CardCache = (eventId: number, nowMs: number) => (steamid: string) => PlayerCard;

export function makeCardCache(db: DB, ttlMs = CARD_TTL_MS): CardCache {
  const memo = new Map<number, { at: number; season: number; cards: Map<string, PlayerCard> }>();
  return (eventId, nowMs) => {
    let m = memo.get(eventId);
    if (!m || nowMs - m.at > ttlMs) {
      m = { at: nowMs, season: currentSeasonId(db), cards: new Map() };
      memo.set(eventId, m);
    }
    const { season, cards } = m;
    return (steamid) => {
      let c = cards.get(steamid);
      if (!c) {
        c = playerCard(db, steamid, season);
        cards.set(steamid, c);
      }
      return c;
    };
  };
}

const toPlayer = (c: PlayerCard): CastDraftPlayer => ({ steamid: c.steamid, name: c.name, avatar: c.avatar, sr: c.sr });
const toCard = (c: PlayerCard): CastDraftCard => ({
  ...toPlayer(c),
  pugs: c.pugs,
  form: [...c.form],
  survivor: { siDamage: c.survivor.siDamage, commonKills: c.survivor.commonKills },
  infected: { damageAsSi: c.infected.damageAsSi, dpsLanded: c.infected.dpsLanded },
  bestClass: c.bestClass?.cls ?? null,
});

/** Callers must check canCastDraft (src/cast/access.ts) first: this does not reject a cancelled or expired draft. Null unless the event is a published draft with its cut published, in live mode. */
export function castDraftView(db: DB, eventId: number, now: Date, cardOf: (steamid: string) => PlayerCard): CastDraftView | null {
  const ev = E.getEvent(db, eventId);
  if (!ev || ev.status === 'draft' || ev.entry_kind !== 'draft' || ev.cut_at === null) return null;
  const v = draftRoomView(db, ev, { steamid: null, staff: false }, now, (ids) => ids.map(cardOf), () => false);
  if (v.status === 'none') return null;
  // Pick numbers only once the order is fixed at Start (Ruling 8).
  const slots = v.status === 'ready' ? [] : snakeSlots(v.order.map((o) => o.steamid), ROUNDS).filter((s) => s.pickNo <= v.totalPicks);
  return {
    eventId: v.eventId,
    eventName: v.eventName,
    status: v.status,
    deadlineAt: v.deadlineAt,
    pausedLeftMs: v.pausedLeftMs,
    pickSeconds: v.settings.pickSeconds,
    totalPicks: v.totalPicks,
    rounds: ROUNDS,
    onClock: v.onClock ? { pickNo: v.onClock.pickNo, round: v.onClock.round, captain: v.onClock.captain, picker: v.onClock.picker } : null,
    teams: v.teams.map((t) => ({
      captain: toPlayer(cardOf(t.captain.steamid)),
      players: t.players.map((p) => toPlayer(cardOf(p.steamid))),
      slots: slots.filter((s) => s.captain === t.captain.steamid).map((s) => s.pickNo),
    })),
    picks: v.picks.map((p) => ({ pickNo: p.pickNo, round: p.round, captain: p.captain, steamid: p.steamid, name: p.name, auto: p.auto, at: p.at })),
    cards: Object.fromEntries(v.picks.map((p) => [p.steamid, toCard(cardOf(p.steamid))])),
    best: [...v.pool].sort((a, b) => b.sr - a.sr || a.name.localeCompare(b.name)).slice(0, BEST_AVAILABLE).map(toCard),
    poolLeft: v.pool.length,
  };
}
