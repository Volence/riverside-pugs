/**
 * Who holds a box out of the pool. The release engine and the balance writer
 * both hold an idle box by moving it idle -> reserved, and a reserved row does
 * not say whose hold it is: an admin's Set idle while one side waits lets the
 * other take the box, and from then on only the side that took it may treat
 * the hold as its own (restart the box, or give it back). In memory only:
 * after a site restart the release engine's recover() takes back what it held.
 */
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
