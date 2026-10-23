/**
 * Who is in a voice channel on the Discord server, kept in memory by the bot
 * (the voice states the gateway hands over at login, then every voice state
 * update), so the ready gate can check presence synchronously without a call
 * to Discord. The sibling of GuildMembership, for voice.
 *
 * `inVoice` answers null while the states are unknown (bot not logged in yet,
 * or Discord down). Callers treat unknown as "allow": a Discord outage must not
 * stop a ready check from completing.
 */
export class VoicePresence {
  /** userId -> channelId, for everyone currently in a voice channel. */
  private channels: Map<string, string> | null = null;
  private leaveListeners: ((userId: string) => void)[] = [];
  private joinListeners: ((userId: string) => void)[] = [];

  setAll(states: Iterable<readonly [string, string]>): void {
    this.channels = new Map(states);
  }

  /** A gateway voice state update: the channel they are in now, or null when
   *  they left voice. A move between channels is not a leave. */
  update(userId: string, channelId: string | null): void {
    if (channelId) {
      // Only a join while the states are known: before setAll there is no
      // "before" to compare with, and a move between channels is not a join.
      const joined = this.channels !== null && !this.channels.has(userId);
      this.channels?.set(userId, channelId);
      if (joined) {
        for (const fn of this.joinListeners) {
          try {
            fn(userId);
          } catch (err) {
            console.error('[discord] voice join listener failed:', err);
          }
        }
      }
      return;
    }
    this.channels?.delete(userId);
    for (const fn of this.leaveListeners) {
      try {
        fn(userId);
      } catch (err) {
        console.error('[discord] voice leave listener failed:', err);
      }
    }
  }

  /** Called when someone leaves voice altogether, after they are out of the map. */
  onLeave(fn: (userId: string) => void): void {
    this.leaveListeners.push(fn);
  }

  /** Called when someone joins voice from outside it, after they are in the map. */
  onJoin(fn: (userId: string) => void): void {
    this.joinListeners.push(fn);
  }

  inVoice(userId: string): boolean | null {
    return this.channels ? this.channels.has(userId) : null;
  }

  /** Forget everything, back to unknown (the bot disconnected). */
  reset(): void {
    this.channels = null;
  }
}
