import type { DB } from './db.js';

/**
 * Who holds a box out of the pool, in two layers.
 *
 * In the database: anything besides a match that keeps an idle box for
 * itself (a practice lease, a queue side game) is an open row of its own
 * table, and the view open_server_holds (src/db.ts) is the union of them. The
 * box stays 'idle' in servers.status, so everything that takes an idle box
 * for itself must AND in NOT_HELD_SQL; tests/serverHoldGuard.test.ts fails on
 * SQL that does not. Priority between holders is each holder's own business
 * (practiceLeases.needServer, sideGames.needServer); this only says who holds.
 *
 * In memory (ServerHolds): the release engine and the balance writer both
 * hold an idle box by moving it idle -> reserved, and a reserved row does not
 * say whose hold it is: an admin's Set idle while one side waits lets the
 * other take the box, and from then on only the side that took it may treat
 * the hold as its own (restart the box, or give it back). After a site
 * restart the release engine's recover() takes back what it held.
 */

/** A kind of database hold; one arm of open_server_holds each. A booking
 *  (rank 0) outranks a practice lease (1) and a side game (2). */
export type HoldKind = 'booking' | 'practice' | 'side';

export interface Hold {
  kind: HoldKind;
  /** The id of the holding row in that kind's own table. */
  rowId: number;
}

/** "Nothing but a match may use this box": AND it into a WHERE on servers.
 *  Unaliased, so the query must not alias servers. */
export const NOT_HELD_SQL = 'id NOT IN (SELECT server_id FROM open_server_holds)';

/** The hold on this box, or null. Two holds on one box (which nothing should
 *  create) answer with the lower rank. */
export function holdFor(db: DB, serverId: number): Hold | null {
  const r = db.prepare('SELECT kind, row_id FROM open_server_holds WHERE server_id = ? ORDER BY rank, row_id LIMIT 1')
    .get(serverId) as { kind: HoldKind; row_id: number } | undefined;
  return r ? { kind: r.kind, rowId: r.row_id } : null;
}

export function isHeld(db: DB, serverId: number): boolean {
  return holdFor(db, serverId) !== null;
}

export type HoldOwner = 'release' | 'balance';

export class ServerHolds {
  private owners = new Map<number, HoldOwner>();

  /** Record a hold the caller has just taken with its own guarded UPDATE. */
  take(serverId: number, owner: HoldOwner): void {
    this.owners.set(serverId, owner);
  }

  owns(serverId: number, owner: HoldOwner): boolean {
    return this.owners.get(serverId) === owner;
  }

  /** Forget the caller's hold; a hold another side took since is kept. */
  drop(serverId: number, owner: HoldOwner): void {
    if (this.owns(serverId, owner)) this.owners.delete(serverId);
  }
}
