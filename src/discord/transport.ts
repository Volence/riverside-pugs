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
  deleteChannel(channelId: string): Promise<void>;
}

export interface BotTransport {
  send(channelId: string, payload: MessagePayload): Promise<string>;
  /** False when the message no longer exists (deleted by hand). */
  edit(channelId: string, messageId: string, payload: MessagePayload): Promise<boolean>;
  remove(channelId: string, messageId: string): Promise<void>;
  onInteraction(handler: (i: BotInteraction) => Promise<InteractionReply>): void;
  registerCommands(defs: SlashCommandDef[]): Promise<void>;
  /** Load the server's member list, then report joins and leaves. */
  watchMembers(h: { all(ids: string[]): void; add(id: string): void; remove(id: string): void }): Promise<void>;
  voice: VoiceOps;
}
