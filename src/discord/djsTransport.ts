import {
  ApplicationCommandOptionType, ApplicationCommandType, ChannelType, Client, Events, GatewayIntentBits, MessageFlags,
  OverwriteType, PermissionFlagsBits, type Guild, type Interaction, type TextBasedChannel,
} from 'discord.js';
import type { DiscordConfig } from '../config.js';
import type {
  BotInteraction, BotTransport, Button, InteractionReply, MessagePayload, RoleOps, SlashCommandDef, VoiceOps,
} from './transport.js';

/**
 * The only file that imports discord.js. Translates the plain transport types
 * 1:1 and owns the gateway connection. Verified live rather than unit tested:
 * everything with logic in it sits behind the BotTransport interface.
 */

const STYLE = { primary: 1, secondary: 2, success: 3, danger: 4 } as const;
const UNKNOWN_MESSAGE = 10008;
const UNKNOWN_CHANNEL = 10003;

function toButton(b: Button) {
  return b.kind === 'link'
    ? { type: 2, style: 5, label: b.label, url: b.url }
    : { type: 2, style: STYLE[b.style], label: b.label, custom_id: b.customId, disabled: b.disabled ?? false };
}

function toMessage(p: MessagePayload) {
  return {
    content: p.content ?? '',
    embeds: p.embeds.map((e) => ({
      title: e.title,
      url: e.url,
      description: e.description,
      color: e.color,
      fields: e.fields,
      footer: e.footer ? { text: e.footer } : undefined,
      image: e.imageUrl ? { url: e.imageUrl } : undefined,
    })),
    components: p.components.map((row) => ({ type: 1, components: row.map(toButton) })),
    // Nothing pings unless explicitly listed: names are user-controlled text.
    allowedMentions: { parse: [] as never[], users: p.mentionUserIds ?? [], roles: p.mentionRoleIds ?? [] },
  };
}

const codeOf = (err: unknown): number | undefined => (err as { code?: number }).code;

export async function createDjsTransport(cfg: DiscordConfig): Promise<BotTransport & { destroy(): Promise<void> }> {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildVoiceStates],
  });
  client.on(Events.Error, (err) => console.error('[discord] client error:', err));

  const ready = new Promise<void>((resolve) => client.once(Events.ClientReady, () => resolve()));
  await client.login(cfg.botToken);
  await ready;
  const guild: Guild = await client.guilds.fetch(cfg.guildId);
  console.log(`[discord] bot logged in as ${client.user?.tag} in ${guild.name}`);

  const textChannel = async (id: string): Promise<TextBasedChannel & { send: Function }> => {
    const ch = await client.channels.fetch(id);
    if (!ch || !ch.isTextBased() || !('send' in ch)) throw new Error(`channel ${id} is not a text channel`);
    return ch as TextBasedChannel & { send: Function };
  };

  let handler: ((i: BotInteraction) => Promise<InteractionReply>) | null = null;

  client.on(Events.InteractionCreate, async (i: Interaction) => {
    if (!handler) return;
    try {
      if (i.isButton()) {
        // Every button reply is private; defer first so a slow handler never
        // blows Discord's three second window.
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        const reply = await handler({
          kind: 'button', customId: i.customId, userId: i.user.id, userName: i.user.globalName ?? i.user.username,
        });
        const m = toMessage(reply.payload);
        await i.editReply({ content: m.content || undefined, embeds: m.embeds, components: m.components as never, allowedMentions: m.allowedMentions });
      } else if (i.isChatInputCommand()) {
        const options: Record<string, string> = {};
        for (const o of i.options.data) {
          if (o.value !== undefined) options[o.name] = String(o.value);
        }
        const interaction: BotInteraction = {
          kind: 'command', name: i.commandName, userId: i.user.id, userName: i.user.globalName ?? i.user.username, options,
        };
        // Whether the reply is private is only known after the handler ran,
        // and a deferral fixes it. Commands are fast DB reads, so reply directly.
        const reply = await handler(interaction);
        const m = toMessage(reply.payload);
        await i.reply({
          content: m.content || undefined, embeds: m.embeds, components: m.components as never,
          allowedMentions: m.allowedMentions, flags: reply.ephemeral ? MessageFlags.Ephemeral : undefined,
        });
      }
    } catch (err) {
      console.error('[discord] interaction failed:', err);
      try {
        if (i.isRepliable()) {
          if (i.deferred || i.replied) await i.editReply({ content: 'Something went wrong. Try again, or use the website.' });
          else await i.reply({ content: 'Something went wrong. Try again, or use the website.', flags: MessageFlags.Ephemeral });
        }
      } catch { /* the interaction is gone; nothing left to tell */ }
    }
  });

  const channelById = async (id: string) => {
    try {
      return guild.channels.cache.get(id) ?? (await guild.channels.fetch(id));
    } catch (err) {
      if (codeOf(err) === UNKNOWN_CHANNEL) return null;
      throw err;
    }
  };

  const voice: VoiceOps = {
    async createMatchChannels(name, teamA, teamB) {
      const me = client.user!.id;
      // An overwrite for someone who is not in the guild is rejected by
      // Discord, which would fail the whole channel; keep members only.
      const members = async (ids: string[]) => {
        const out: string[] = [];
        for (const id of ids) {
          try {
            await guild.members.fetch(id);
            out.push(id);
          } catch { /* left the server */ }
        }
        return out;
      };
      const category = await guild.channels.create({ name, type: ChannelType.GuildCategory });
      const make = async (label: string, ids: string[]) => guild.channels.create({
        name: label,
        type: ChannelType.GuildVoice,
        parent: category.id,
        permissionOverwrites: [
          { id: guild.roles.everyone.id, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.Connect] },
          ...(await members(ids)).map((id) => ({
            id, type: OverwriteType.Member,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak],
          })),
          {
            id: me, type: OverwriteType.Member,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.MoveMembers, PermissionFlagsBits.ManageChannels],
          },
        ],
      });
      const a = await make(teamA.label, teamA.userIds);
      const b = await make(teamB.label, teamB.userIds);
      return { categoryId: category.id, teamAId: a.id, teamBId: b.id };
    },
    async memberVoiceChannel(userId) {
      return guild.voiceStates.cache.get(userId)?.channelId ?? null;
    },
    async move(userId, channelId) {
      const member = await guild.members.fetch(userId);
      await member.voice.setChannel(channelId);
    },
    async channelMemberCount(channelId) {
      const ch = await channelById(channelId);
      if (!ch) return null;
      return 'members' in ch && ch.type === ChannelType.GuildVoice ? ch.members.size : 0;
    },
    async channelMemberIds(channelId) {
      const ch = await channelById(channelId);
      if (!ch) return null;
      return 'members' in ch && ch.type === ChannelType.GuildVoice ? [...ch.members.keys()] : [];
    },
    async deleteChannel(channelId) {
      const ch = await channelById(channelId);
      await ch?.delete().catch((err: unknown) => {
        if (codeOf(err) !== UNKNOWN_CHANNEL) throw err;
      });
    },
  };

  const roles: RoleOps = {
    async add(userId, roleId) {
      const member = await guild.members.fetch(userId);
      await member.roles.add(roleId);
    },
    async remove(userId, roleId) {
      const member = await guild.members.fetch(userId);
      await member.roles.remove(roleId);
    },
    async has(userId, roleId) {
      // Null rather than false when the member cannot be read: "we could not
      // tell" and "they do not have it" lead to opposite replies, and guessing
      // would tell someone they had been removed from a role they still hold.
      try {
        const member = await guild.members.fetch(userId);
        return member.roles.cache.has(roleId);
      } catch (err) {
        console.error(`[discord] could not read roles for ${userId}:`, err);
        return null;
      }
    },
  };

  return {
    roles,
    async send(channelId, payload) {
      const ch = await textChannel(channelId);
      const msg = await ch.send(toMessage(payload));
      return msg.id as string;
    },
    async edit(channelId, messageId, payload) {
      const ch = await textChannel(channelId);
      try {
        const msg = await ch.messages.fetch(messageId);
        const m = toMessage(payload);
        await msg.edit({ content: m.content, embeds: m.embeds, components: m.components as never, allowedMentions: m.allowedMentions });
        return true;
      } catch (err) {
        if (codeOf(err) === UNKNOWN_MESSAGE) return false;
        throw err;
      }
    },
    async remove(channelId, messageId) {
      const ch = await textChannel(channelId);
      try {
        const msg = await ch.messages.fetch(messageId);
        await msg.delete();
      } catch (err) {
        if (codeOf(err) !== UNKNOWN_MESSAGE) throw err;
      }
    },
    async dm(userId, payload) {
      // No extra gateway intent: sending a DM is a REST call. users.fetch
      // resolves anyone by id; send() is what fails for closed DMs (50007).
      const user = await client.users.fetch(userId);
      const m = toMessage(payload);
      await user.send({
        content: m.content || undefined, embeds: m.embeds, components: m.components as never,
        allowedMentions: m.allowedMentions,
      });
    },
    onInteraction(h) {
      handler = h;
    },
    async registerCommands(defs: SlashCommandDef[]) {
      await guild.commands.set(defs.map((d) => ({
        type: ApplicationCommandType.ChatInput as const,
        name: d.name,
        description: d.description,
        options: (d.options ?? []).map((o) => ({
          name: o.name,
          description: o.description,
          required: o.required ?? false,
          type: o.type === 'user' ? ApplicationCommandOptionType.User
            : o.type === 'integer' ? ApplicationCommandOptionType.Integer : ApplicationCommandOptionType.String,
          ...(o.choices ? { choices: o.choices } : {}),
        })) as never,
      })));
    },
    async watchMembers(h) {
      client.on(Events.GuildMemberAdd, (m) => { if (m.guild.id === guild.id) h.add(m.id); });
      client.on(Events.GuildMemberRemove, (m) => { if (m.guild.id === guild.id) h.remove(m.id); });
      const all = await guild.members.fetch();
      h.all([...all.keys()]);
      console.log(`[discord] tracking ${all.size} server members`);
    },
    async watchVoice(h) {
      client.on(Events.VoiceStateUpdate, (_before, after) => {
        if (after.guild.id === guild.id) h.update(after.id, after.channelId ?? null);
      });
      // The gateway sends the guild's voice states with the guild itself, so
      // this cache is complete as soon as the client is ready.
      const states: [string, string][] = [];
      for (const vs of guild.voiceStates.cache.values()) {
        if (vs.channelId) states.push([vs.id, vs.channelId]);
      }
      h.all(states);
      console.log(`[discord] tracking voice: ${states.length} in a channel`);
    },
    voice,
    async destroy() {
      await client.destroy();
    },
  };
}
