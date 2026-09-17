/**
 * Who is in the Discord server, kept in memory by the bot (a full member fetch
 * at login, then join and leave events), so the queue can check membership
 * synchronously on every join without calling Discord.
 *
 * `isMember` answers null while the list is unknown (bot not logged in yet, or
 * Discord down). Callers treat unknown as "allow": a Discord outage must not
 * stop the PUG from running.
 */
export class GuildMembership {
  private members: Set<string> | null = null;
  private addListeners: ((userId: string) => void)[] = [];

  setAll(ids: Iterable<string>): void {
    this.members = new Set(ids);
  }

  add(userId: string): void {
    this.members?.add(userId);
    for (const fn of this.addListeners) {
      try {
        fn(userId);
      } catch (err) {
        console.error('[discord] member add listener failed:', err);
      }
    }
  }

  remove(userId: string): void {
    this.members?.delete(userId);
  }

  /** Called when someone joins the server, after they are in the set. */
  onAdd(fn: (userId: string) => void): void {
    this.addListeners.push(fn);
  }

  isMember(userId: string): boolean | null {
    return this.members ? this.members.has(userId) : null;
  }

  /** Forget everything, back to unknown (the bot disconnected). */
  reset(): void {
    this.members = null;
  }
}
