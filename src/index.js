import { API, Client, GatewayDispatchEvents } from '@discordjs/core';
import { REST } from '@discordjs/rest';
import { WebSocketManager, WebSocketShardEvents } from '@discordjs/ws';
import { getFreeDeals, getStores, resolveStores } from './cheapshark.js';
import { loadConfig } from './config.js';
import { dealEmbed, dealListEmbed, helpEmbed, mentionFor, storesEmbed } from './embeds.js';
import { sendMessage } from './send.js';
import { PostedState } from './state.js';

const config = loadConfig();
const state = new PostedState(config.dataDir);
await state.load();

// Same setup as the official Fluxer quickstart: Fluxer's API is Discord-compatible.
const rest = new REST({ api: config.apiUrl, version: config.apiVersion }).setToken(config.token);
const api = new API(rest);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function configuredStores() {
  const all = await getStores();
  const { matched, unknown } = resolveStores(all, config.stores);
  if (unknown.length) console.warn(`[stores] unknown store(s) in STORES: ${unknown.join(', ')}`);
  return { all, matched, byId: new Map(all.map((s) => [s.storeID, s])) };
}

let polling = false;

async function poll() {
  if (polling) return;
  polling = true;
  try {
    const { matched, byId } = await configuredStores();
    if (matched.length === 0) {
      console.warn('[poll] no valid stores configured, skipping');
      return;
    }
    const deals = await getFreeDeals(
      matched.map((s) => s.storeID),
      { includeFreeToPlay: config.includeFreeToPlay, fresh: true },
    );
    state.touch(deals.map((d) => d.dealID));
    const fresh = deals.filter((d) => !state.has(d.dealID));

    if (!state.initialized && !config.postOnFirstRun) {
      for (const deal of fresh) state.markPosted(deal.dealID);
      console.log(`[poll] first run, remembered ${fresh.length} current free deal(s) without posting`);
    } else {
      console.log(`[poll] ${deals.length} free deal(s), ${fresh.length} new`);
      const mention = mentionFor(config.mentionRole);
      for (const [index, deal] of fresh.entries()) {
        await sendMessage(api, config.channelId, {
          // Ping the role once per batch, not once per game.
          content: index === 0 ? mention.content : undefined,
          allowed_mentions: index === 0 ? mention.allowed_mentions : { parse: [] },
          embeds: [dealEmbed(deal, byId)],
        });
        state.markPosted(deal.dealID);
        await state.save();
        // Stay well below Fluxer's 5 messages / 5 seconds per channel limit.
        await sleep(1500);
      }
    }
    state.initialized = true;
    await state.save();
  } catch (err) {
    console.error('[poll] failed:', err.message, err.rawError ? JSON.stringify(err.rawError) : '');
  } finally {
    polling = false;
  }
}

let pollTimer;
function schedulePolling() {
  if (pollTimer) return;
  console.log(`[poll] checking every ${config.pollMinutes} minute(s)`);
  poll();
  pollTimer = setInterval(poll, config.pollMinutes * 60 * 1000);
}

const lastCommandAt = new Map();

async function handleCommand(api, message, name, args) {
  const reply = (body) =>
    sendMessage(api, message.channel_id, {
      ...body,
      allowed_mentions: { parse: [] },
      message_reference: { message_id: message.id },
    });

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
    default:
  }
}

const COMMANDS = new Set(['free', 'freegames', 'stores', 'help']);

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
      console.error(`[command] ${command} failed:`, err.message);
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
await connect();
