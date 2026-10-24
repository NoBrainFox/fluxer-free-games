import { API, Client, GatewayDispatchEvents } from '@discordjs/core';
import { REST } from '@discordjs/rest';
import { WebSocketManager, WebSocketShardEvents } from '@discordjs/ws';
import { ChannelList } from './channels.js';
import { getFreeDeals, getStores, resolveStores } from './cheapshark.js';
import { loadConfig } from './config.js';
import { channelsEmbed, dealEmbed, dealListEmbed, helpEmbed, mentionFor, storesEmbed } from './embeds.js';
import { findEndDate } from './enddates.js';
import { canManageGuild } from './permissions.js';
import { sendMessage } from './send.js';
import { PostedState } from './state.js';

const config = loadConfig();
const channelList = new ChannelList(config.dataDir, config.channels);
await channelList.load();
const state = new PostedState(config.dataDir);
// Older versions only knew one channel, so their saved posts belong to the first .env channel.
await state.load(config.channels[0]?.channelId);

// Same setup as the official Fluxer quickstart: Fluxer's API is Discord-compatible.
const rest = new REST({ api: config.apiUrl, version: config.apiVersion }).setToken(config.token);
const api = new API(rest);
let botUserId;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Polls, reloads and subscriptions all change posts and state, so they run one at a time.
let queue = Promise.resolve();
function exclusive(task) {
  const run = queue.then(task);
  queue = run.catch(() => {});
  return run;
}

async function configuredStores() {
  const all = await getStores();
  const { matched, unknown } = resolveStores(all, config.stores);
  if (unknown.length) console.warn(`[stores] unknown store(s) in STORES: ${unknown.join(', ')}`);
  return { all, matched, byId: new Map(all.map((s) => [s.storeID, s])) };
}

async function currentDeals() {
  const { matched, byId } = await configuredStores();
  if (matched.length === 0) throw new Error('no valid stores configured');
  const deals = await getFreeDeals(
    matched.map((s) => s.storeID),
    { includeFreeToPlay: config.includeFreeToPlay, fresh: true },
  );
  state.touch(deals.map((d) => d.dealID));
  return { deals, byId };
}

// End dates are looked up once per deal, however many channels it goes to.
function endDateLookup(byId) {
  const found = new Map();
  return async (deal) => {
    if (!config.showEndDates) return null;
    if (!found.has(deal.dealID)) found.set(deal.dealID, await findEndDate(deal.title, byId.get(deal.storeID)?.storeName));
    return found.get(deal.dealID);
  };
}

// Role names from .env are turned into IDs once; roles added by command are stored as IDs already.
const resolvedRoles = new Map();
const guildIds = new Map();

async function guildOf(channelId) {
  if (!guildIds.has(channelId)) guildIds.set(channelId, (await rest.get(`/channels/${channelId}`)).guild_id);
  return guildIds.get(channelId);
}

// Returns a role ID, "everyone", "here" or "" (no ping). Throws if a named role doesn't exist.
async function resolveRole(guildId, raw) {
  const value = raw.trim().replace(/^<@&|>$/g, '');
  if (!value || /^\d+$/.test(value)) return value;
  if (/^@?(everyone|here)$/i.test(value)) return value.replace('@', '').toLowerCase();
  const roles = await rest.get(`/guilds/${guildId}/roles`);
  const role = roles.find((r) => r.name.toLowerCase() === value.toLowerCase());
  if (!role) throw Object.assign(new Error(`no role named "${value}"`), { roleNames: roles.map((r) => r.name) });
  return role.id;
}

async function resolveEnvRoles() {
  for (const { channelId, role } of config.channels) {
    try {
      const id = await resolveRole(/^\d*$/.test(role) ? null : await guildOf(channelId), role);
      resolvedRoles.set(channelId, id);
      if (id !== role) console.log(`[config] role "${role}" for channel ${channelId} is ${id}`);
    } catch (err) {
      resolvedRoles.set(channelId, '');
      const known = err.roleNames ? ` Roles: ${err.roleNames.join(', ')}` : '';
      console.warn(`[config] channel ${channelId}: ${err.message}, announcing there without a ping.${known}`);
    }
  }
}

// Posts deals to one channel, pinging its role once for the batch.
async function postDeals(channel, deals, { byId, endOf, ping = true }) {
  const mention = mentionFor(ping ? (resolvedRoles.get(channel.channelId) ?? channel.role) : '');
  for (const [index, deal] of deals.entries()) {
    const end = await endOf(deal);
    const message = await sendMessage(api, channel.channelId, {
      content: index === 0 ? mention.content : undefined,
      allowed_mentions: index === 0 ? mention.allowed_mentions : { parse: [] },
      embeds: [dealEmbed(deal, byId, end, config.endDateStyle)],
    });
    state.markPosted(deal.dealID, channel.channelId, message.id, end ? { endsAt: end.endsAt.getTime() } : {});
    await state.save();
    // Stay well below Fluxer's 5 messages / 5 seconds per channel limit.
    await sleep(1500);
  }
}

async function runPoll() {
  const { deals, byId } = await currentDeals();
  const channels = channelList.all();

  if (!state.initialized && !config.postOnFirstRun) {
    for (const deal of deals) {
      state.markPosted(deal.dealID, null);
      for (const { channelId } of channels) state.markPosted(deal.dealID, channelId);
    }
    console.log(`[poll] first run, remembered ${deals.length} current free deal(s) without posting`);
  } else {
    console.log(`[poll] ${deals.length} free deal(s), ${channels.length} channel(s)`);
    const endOf = endDateLookup(byId);
    for (const channel of channels) {
      const fresh = deals.filter((d) => !state.postedIn(d.dealID, channel.channelId));
      if (fresh.length === 0) continue;
      console.log(`[poll] posting ${fresh.length} new deal(s) to channel ${channel.channelId}`);
      try {
        await postDeals(channel, fresh, { byId, endOf });
      } catch (err) {
        // One broken channel (bot kicked, channel deleted) must not stop the others.
        console.error(`[poll] could not post to channel ${channel.channelId}: ${describe(err)}`);
      }
    }
  }
  state.initialized = true;
  await state.save();
  if (config.deleteExpiredPosts) await deleteExpiredPosts(new Set(deals.map((d) => d.dealID)));
}

function describe(err) {
  return `${err.message} ${err.rawError ? JSON.stringify(err.rawError) : ''}`.trim();
}

let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  try {
    await exclusive(runPoll);
  } catch (err) {
    console.error('[poll] failed:', describe(err));
  } finally {
    polling = false;
  }
}

// Deletes one post; true when it is gone (including already deleted by hand, 404).
async function deletePost(channelId, messageId, what) {
  try {
    await api.channels.deleteMessage(channelId, messageId);
    return true;
  } catch (err) {
    if (err.status === 404) return true;
    // 403: the bot lost access to the channel, so retrying won't help.
    if (err.status === 403) {
      console.warn(`[cleanup] no access to delete ${what} in channel ${channelId}, giving up on it`);
      return true;
    }
    console.warn(`[cleanup] could not delete ${what} in channel ${channelId}, will retry: ${err.message}`);
    return false;
  }
}

// Only runs after a successful poll, so a CheapShark outage never deletes anything:
// still-free deals have just had lastSeen refreshed by state.touch().
async function deleteExpiredPosts(stillFree) {
  for (const [dealID, entry] of state.expired(config.deleteGraceMinutes * 60 * 1000)) {
    let allGone = true;
    for (const [channelId, messageId] of Object.entries(entry.channels)) {
      if (!messageId) continue;
      if (await deletePost(channelId, messageId, `post for deal ${dealID}`)) {
        state.forgetMessage(dealID, channelId);
        console.log(`[cleanup] deleted post for expired deal ${dealID} in channel ${channelId}`);
      } else {
        allGone = false;
      }
      await sleep(1000);
    }
    // Forget the deal so a later giveaway of the same game is announced again. If CheapShark
    // still lists it (its end date passed first), keep it so it isn't reposted.
    if (allGone && !stillFree.has(dealID)) state.forget(dealID);
    await state.save();
  }
}

// Every message the bot posted in a channel: the ones it tracked plus any found in recent history.
async function botMessagesIn(channelId) {
  const ids = new Set(state.messagesIn(channelId).map(([, messageId]) => messageId));
  let before;
  try {
    for (let page = 0; page < 5; page++) {
      const query = new URLSearchParams({ limit: '100', ...(before && { before }) });
      const messages = await rest.get(`/channels/${channelId}/messages`, { query });
      for (const message of messages) if (message.author?.id === botUserId) ids.add(message.id);
      if (messages.length < 100) break;
      before = messages.at(-1).id;
    }
  } catch (err) {
    console.warn(`[reload] could not read history of channel ${channelId}, deleting tracked posts only: ${err.message}`);
  }
  return [...ids];
}

async function reloadChannel(channel, ping) {
  const old = await botMessagesIn(channel.channelId);
  for (const messageId of old) {
    await deletePost(channel.channelId, messageId, `message ${messageId}`);
    await sleep(250);
  }
  for (const [dealID] of state.messagesIn(channel.channelId)) state.forgetMessage(dealID, channel.channelId);
  await state.save();

  const { deals, byId } = await currentDeals();
  await postDeals(channel, deals, { byId, endOf: endDateLookup(byId), ping });
  return { deleted: old.length, posted: deals.length };
}

let pollTimer;
function schedulePolling() {
  if (pollTimer) return;
  console.log(`[poll] checking every ${config.pollMinutes} minute(s)`);
  poll();
  pollTimer = setInterval(poll, config.pollMinutes * 60 * 1000);
}

async function canManage(message) {
  const guildId = message.guild_id ?? (await guildOf(message.channel_id));
  if (!guildId) return false;
  const userId = message.author.id;
  const guild = await rest.get(`/guilds/${guildId}`);
  if (guild.owner_id === userId) return true;
  const roles = guild.roles ?? (await rest.get(`/guilds/${guildId}/roles`));
  const memberRoleIds = message.member?.roles ?? (await rest.get(`/guilds/${guildId}/members/${userId}`)).roles ?? [];
  return canManageGuild({ guildId, ownerId: guild.owner_id, userId, roles, memberRoleIds });
}

function roleLabel(role) {
  if (!role) return 'no ping';
  return role === 'everyone' || role === 'here' ? `@${role}` : `<@&${role}>`;
}

const lastCommandAt = new Map();
const ADMIN_COMMANDS = new Set(['subscribe', 'unsubscribe', 'channels', 'reload']);

async function handleCommand(api, message, name, args) {
  const reply = (body) =>
    sendMessage(api, message.channel_id, {
      ...body,
      allowed_mentions: { parse: [] },
      message_reference: { message_id: message.id },
    });

  if (ADMIN_COMMANDS.has(name) && !(await canManage(message))) {
    await reply({ content: 'Only the community owner or members with Manage Server or Administrator can do that.' });
    return;
  }

  const here = channelList.get(message.channel_id);
  switch (name) {
    case 'free':
    case 'freegames': {
      const { all, matched, byId } = await configuredStores();
      let stores = matched;
      let title = 'Free games right now';
      if (args.length) {
        const result = resolveStores(all, [args.join(' ')]);
        if (result.matched.length === 0) {
          await reply({ content: `I don't know the store "${args.join(' ')}". Try \`${config.prefix}stores\`.` });
          return;
        }
        stores = result.matched;
        if (stores.length === 1) title = `Free games on ${stores[0].storeName}`;
      }
      const deals = await getFreeDeals(
        stores.map((s) => s.storeID),
        { includeFreeToPlay: config.includeFreeToPlay },
      );
      await reply({ embeds: [dealListEmbed(deals, byId, title)] });
      return;
    }
    case 'stores': {
      const { all, matched } = await configuredStores();
      await reply({ embeds: [storesEmbed(all, matched)] });
      return;
    }
    case 'help':
      await reply({ embeds: [helpEmbed(config.prefix, config.pollMinutes)] });
      return;
    case 'subscribe': {
      if (here?.source === 'env') {
        await reply({ content: 'This channel is set in the bot\'s .env file (FLUXER_CHANNELS), so change it there.' });
        return;
      }
      const guildId = message.guild_id ?? (await guildOf(message.channel_id));
      let role;
      try {
        role = await resolveRole(guildId, args.join(' '));
      } catch (err) {
        const known = err.roleNames ? ` Roles here: ${err.roleNames.filter((r) => r !== '@everyone').join(', ')}` : '';
        await reply({ content: `I couldn't find that role (${err.message}).${known}` });
        return;
      }
      channelList.add(message.channel_id, role, { guildId, addedBy: message.author.id });
      await channelList.save();
      await reply({
        content: here
          ? `Updated: this channel now pings ${roleLabel(role)}.`
          : `This channel now gets free game announcements (${roleLabel(role)}). Posting the games that are free right now.`,
      });
      // Posts the current free games here; other channels only get what's new for them.
      if (!here) await exclusive(runPoll).catch((err) => console.error('[poll] failed:', describe(err)));
      return;
    }
    case 'unsubscribe': {
      if (!here) {
        await reply({ content: 'This channel isn\'t getting announcements.' });
      } else if (here.source === 'env') {
        await reply({ content: 'This channel is set in the bot\'s .env file (FLUXER_CHANNELS), so remove it there.' });
      } else {
        channelList.remove(message.channel_id);
        await channelList.save();
        await reply({ content: 'This channel won\'t get announcements anymore. Existing posts stay.' });
      }
      return;
    }
    case 'channels':
      await reply({
        embeds: [channelsEmbed(channelList.all().map((c) => ({ ...c, label: roleLabel(resolvedRoles.get(c.channelId) ?? c.role) })))],
      });
      return;
    case 'reload': {
      if (!here) {
        await reply({ content: `This channel isn't getting announcements. Use \`${config.prefix}subscribe\` first.` });
        return;
      }
      const { deleted, posted } = await exclusive(() => reloadChannel(here, args[0]?.toLowerCase() === 'ping'));
      await reply({ content: `Reloaded: removed ${deleted} old message(s) and posted ${posted} free game(s).` });
      return;
    }
    default:
  }
}

const COMMANDS = new Set(['free', 'freegames', 'stores', 'help', ...ADMIN_COMMANDS]);

function registerHandlers(client) {
  client.on(GatewayDispatchEvents.MessageCreate, async ({ api, data }) => {
    if (data.author?.bot || !data.content?.startsWith(config.prefix)) return;
    const [name, ...args] = data.content.slice(config.prefix.length).trim().split(/\s+/);
    const command = name?.toLowerCase();
    if (!COMMANDS.has(command)) return;

    // Per-channel cooldown keeps chatty channels from hammering the APIs.
    const now = Date.now();
    if (now - (lastCommandAt.get(data.channel_id) ?? 0) < config.commandCooldownSeconds * 1000) return;
    lastCommandAt.set(data.channel_id, now);

    try {
      await handleCommand(api, data, command, args);
    } catch (err) {
      console.error(`[command] ${command} failed:`, describe(err));
    }
  });

  client.on(GatewayDispatchEvents.Ready, ({ data }) => {
    console.log(`[gateway] logged in as @${data.user.username}`);
    schedulePolling();
  });
}

// Fluxer's gateway docs say IDENTIFY needs the "Bot " prefix, while the quickstart
// passes the bare token, so try the documented form first and fall back once.
const identifyTokens = [`Bot ${config.token}`, config.token];
let gateway;
let loggedGatewayUrl;

function fatal(message) {
  console.error(`[bot] ${message}`);
  process.exit(1);
}

// Check the API URL and token over REST first; the errors are much clearer than the gateway's.
async function checkApi() {
  console.log(`[api] using ${config.apiUrl}/v${config.apiVersion}`);
  try {
    const me = await rest.get('/users/@me');
    botUserId = me.id;
    console.log(`[api] token belongs to @${me.username}`);
  } catch (err) {
    if (err.status === 401) {
      fatal(
        `${config.apiUrl} rejected the bot token (HTTP 401). Check FLUXER_BOT_TOKEN, and that the bot was ` +
          'created on the same Fluxer instance FLUXER_API_URL points to.',
      );
    }
    if (err.status === 404) {
      fatal(
        `${config.apiUrl}/v${config.apiVersion} is not a Fluxer API (HTTP 404). For a self-hosted instance set ` +
          'FLUXER_API_URL to the part of your API URL before /v1, e.g. https://chat.example.com/api.',
      );
    }
    fatal(`could not reach the Fluxer API at ${config.apiUrl}: ${err.message}`);
  }
}

async function connect(attempt = 0) {
  gateway = new WebSocketManager({
    intents: config.intents,
    rest,
    token: identifyTokens[attempt],
    version: config.apiVersion,
  });
  registerHandlers(new Client({ rest, gateway }));

  // Log (and optionally override) where the gateway connection goes, so a
  // self-hosted setup that still points at fluxer.app is easy to spot.
  const fetchGatewayInformation = gateway.fetchGatewayInformation.bind(gateway);
  gateway.fetchGatewayInformation = async (force) => {
    const info = await fetchGatewayInformation(force);
    const url = config.gatewayUrl || info.url;
    if (url !== loggedGatewayUrl) console.log(`[gateway] connecting to ${(loggedGatewayUrl = url)}`);
    return { ...info, url };
  };

  // Without a listener the manager's 'error' event would crash the process.
  gateway.on(WebSocketShardEvents.Error, (err) => {
    if (err.message !== 'Authentication failed') console.error('[gateway] error:', err.message);
  });

  try {
    await gateway.connect();
  } catch (err) {
    if (err.message === 'Authentication failed') {
      await gateway.destroy().catch(() => {});
      if (attempt + 1 < identifyTokens.length) {
        console.warn('[gateway] login rejected, retrying with the token format from the Fluxer quickstart');
        return connect(attempt + 1);
      }
      fatal(
        'Fluxer rejected the bot token (gateway close code 4004). Check FLUXER_BOT_TOKEN in .env: ' +
          'it must be the token from the Bot section of your application, not the client secret, ' +
          'and it changes every time you click "Reset Token".',
      );
    }
    if (err.status === 401) fatal('Fluxer rejected the bot token (HTTP 401). Check FLUXER_BOT_TOKEN in .env.');
    fatal(`could not connect to Fluxer at ${config.apiUrl}: ${err.message}`);
  }
}

function shutdown(signal) {
  console.log(`[bot] ${signal} received, shutting down`);
  clearInterval(pollTimer);
  gateway.destroy().finally(() => process.exit(0));
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

await checkApi();
await resolveEnvRoles();
await connect();
