/**
 * The seam between the bot's logic and discord.js.
 *
 * Everything the bot decides is expressed in these plain types, so presenters,
 * the controller and the sync loop are tested against an in-memory fake. Only
 * djsTransport.ts imports discord.js, and it translates these types 1:1.
 */

export interface EmbedField { name: string; value: string; inline?: boolean }

export interface Embed {
  title?: string;
  url?: string;
  description?: string;
  color?: number;
  fields?: EmbedField[];
  footer?: string;
  imageUrl?: string;
}

export type Button =
  | {
      kind: 'button';
      customId: string;
      label: string;
      style: 'primary' | 'secondary' | 'success' | 'danger';
      disabled?: boolean;
    }
  | { kind: 'link'; url: string; label: string };

/** At most five buttons per row, at most five rows (Discord's limits). */
export type ActionRow = Button[];

export interface MessagePayload {
  content?: string;
  embeds: Embed[];
  components: ActionRow[];
  /** User ids the content may actually ping. Everything else is inert text,
   *  so a stray <@id> in a name can never mass-ping. */
  mentionUserIds?: string[];
  /** Role ids the content may ping, under the same allowlist rule. Separate
   *  from mentionUserIds because Discord treats them as different categories:
   *  permitting a user never permits a role, and the queue alert is the one
   *  message that needs a role and no users. */
  mentionRoleIds?: string[];
}

export type BotInteraction =
  | { kind: 'button'; customId: string; userId: string; userName: string }
  | {
      kind: 'command';
      name: string;
      userId: string;
      userName: string;
      /** String options by name. A user option carries the user id. */
      options: Record<string, string>;
    };

export interface InteractionReply {
  ephemeral: boolean;
  payload: MessagePayload;
}

export interface SlashOption {
  name: string;
  description: string;
  type: 'user' | 'string' | 'integer';
  required?: boolean;
  /** Fixed choices, shown as a picker. */
  choices?: { name: string; value: string }[];
}

export interface SlashCommandDef {
  name: string;
  description: string;
  options?: SlashOption[];
}

/** The voice operations team channels need. Ids are Discord snowflakes. */
export interface VoiceOps {
  createMatchChannels(
    name: string,
    teamA: { label: string; userIds: string[] },
    teamB: { label: string; userIds: string[] },
  ): Promise<{ categoryId: string; teamAId: string; teamBId: string }>;
  /** The voice channel a guild member is sitting in, or null. */
  memberVoiceChannel(userId: string): Promise<string | null>;
  move(userId: string, channelId: string): Promise<void>;
  /** Members currently in the channel; null when the channel no longer exists. */
  channelMemberCount(channelId: string): Promise<number | null>;
  /** Who is currently in the channel; null when it no longer exists. */
  channelMemberIds(channelId: string): Promise<string[] | null>;
  deleteChannel(channelId: string): Promise<void>;
}

/** Adding and removing one opt-in role, for the queue-alert toggle.
 *
 *  Narrow on purpose: this is not general role management. The bot is given a
 *  single configured role id and can only put a member in it or take them out,
 *  so a bug here cannot hand anyone permissions. */
export interface RoleOps {
  add(userId: string, roleId: string): Promise<void>;
  remove(userId: string, roleId: string): Promise<void>;
  /** Whether the member currently holds it; null when the member or the role
   *  cannot be read, which the caller reports rather than guessing. */
  has(userId: string, roleId: string): Promise<boolean | null>;
}

export interface BotTransport {
  send(channelId: string, payload: MessagePayload): Promise<string>;
  /** False when the message no longer exists (deleted by hand). */
  edit(channelId: string, messageId: string, payload: MessagePayload): Promise<boolean>;
  remove(channelId: string, messageId: string): Promise<void>;
  /** A direct message to one user. Rejects when Discord refuses it, which is
   *  ordinary: the user has DMs from server members closed, or has left the
   *  guild and shares no server with the bot. Callers decide what that means. */
  dm(userId: string, payload: MessagePayload): Promise<void>;
  onInteraction(handler: (i: BotInteraction) => Promise<InteractionReply>): void;
  registerCommands(defs: SlashCommandDef[]): Promise<void>;
  /** Load the server's member list, then report joins and leaves. */
  watchMembers(h: { all(ids: string[]): void; add(id: string): void; remove(id: string): void }): Promise<void>;
  /** Load who is in which voice channel, then report every change: the
   *  channel they are in now, or null when they left voice. */
  watchVoice(h: { all(states: [userId: string, channelId: string][]): void; update(userId: string, channelId: string | null): void }): Promise<void>;
  voice: VoiceOps;
  roles: RoleOps;
}
