// All configuration comes from environment variables so the bot can be run
// with nothing but a .env file and docker compose.

export const MIN_POLL_MINUTES = 15;
export const MAX_POLL_MINUTES = 1440;

function str(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

function int(name, fallback) {
  const raw = str(name);
  if (raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) throw new Error(`${name} must be a number, got "${raw}"`);
  return value;
}

function bool(name, fallback) {
  const raw = str(name).toLowerCase();
  if (raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function list(name, fallback) {
  const raw = str(name, fallback);
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

// FLUXER_CHANNELS="111:Free Games,222,333:everyone" -> one entry per channel with an optional role.
// The older FLUXER_CHANNEL_ID + MENTION_ROLE pair still works and is added to the list.
export function parseChannels(channelsValue, legacyChannelId = '', legacyRole = '') {
  const channels = [];
  for (const entry of channelsValue.split(',')) {
    const [channelId, ...role] = entry.split(':');
    if (!channelId.trim()) continue;
    if (!/^\d+$/.test(channelId.trim())) throw new Error(`FLUXER_CHANNELS: "${channelId.trim()}" is not a channel ID`);
    channels.push({ channelId: channelId.trim(), role: role.join(':').trim() });
  }
  if (legacyChannelId && !channels.some((c) => c.channelId === legacyChannelId)) {
    channels.push({ channelId: legacyChannelId, role: legacyRole });
  }
  return channels;
}

export function loadConfig() {
  // Accept the token with or without surrounding quotes or a "Bot " prefix; the bot adds the prefix itself.
  const token = str('FLUXER_BOT_TOKEN')
    .replace(/^["']|["']$/g, '')
    .replace(/^Bot\s+/i, '');
  if (!token) throw new Error('FLUXER_BOT_TOKEN is required');

  const channels = parseChannels(str('FLUXER_CHANNELS'), str('FLUXER_CHANNEL_ID'), str('MENTION_ROLE'));
  if (channels.length === 0) {
    console.warn('[config] no FLUXER_CHANNELS set, announcing only in channels added with the subscribe command');
  }

  let pollMinutes = int('POLL_INTERVAL_MINUTES', 60);
  if (pollMinutes < MIN_POLL_MINUTES || pollMinutes > MAX_POLL_MINUTES) {
    const clamped = Math.min(Math.max(pollMinutes, MIN_POLL_MINUTES), MAX_POLL_MINUTES);
    console.warn(
      `[config] POLL_INTERVAL_MINUTES=${pollMinutes} is outside ${MIN_POLL_MINUTES}-${MAX_POLL_MINUTES}, using ${clamped}`,
    );
    pollMinutes = clamped;
  }

  const contactEmail = str('CONTACT_EMAIL');
  if (!contactEmail) {
    console.warn('[config] CONTACT_EMAIL is not set, CheapShark requests will not include a contact address');
  } else if (!/^[^\s@;()]+@[^\s@;()]+$/.test(contactEmail)) {
    throw new Error(`CONTACT_EMAIL does not look like an email address: "${contactEmail}"`);
  }

  return {
    token,
    apiUrl: str('FLUXER_API_URL', 'https://api.fluxer.app').replace(/\/+$/, ''),
    // Optional: overrides the gateway URL the API advertises (useful for self-hosted instances).
    gatewayUrl: str('FLUXER_GATEWAY_URL'),
    apiVersion: str('FLUXER_API_VERSION', '1'),
    intents: int('FLUXER_GATEWAY_INTENTS', 0),
    // Channels from .env, each with its own role to ping (a role ID or name, "everyone", "here" or empty).
    channels,
    // Store IDs or names, e.g. "Steam,GOG,Epic Games Store" or "1,7,25". "all" means every active store.
    stores: list('STORES', 'Steam,GOG,Epic Games Store'),
    pollMinutes,
    includeFreeToPlay: bool('INCLUDE_FREE_TO_PLAY', false),
    postOnFirstRun: bool('POST_ON_FIRST_RUN', true),
    prefix: str('COMMAND_PREFIX', '!'),
    commandCooldownSeconds: int('COMMAND_COOLDOWN_SECONDS', 10),
    showEndDates: bool('SHOW_END_DATES', true),
    // "discord" uses <t:...> timestamp tags; "text" writes a plain UTC date for clients that don't render them.
    endDateStyle: str('END_DATE_STYLE', 'discord').toLowerCase() === 'text' ? 'text' : 'discord',
    deleteExpiredPosts: bool('DELETE_EXPIRED_POSTS', false),
    // A short grace period would delete posts when a game only briefly drops out of CheapShark's list.
    deleteGraceMinutes: Math.max(int('DELETE_GRACE_MINUTES', 120), MIN_POLL_MINUTES),
    dataDir: str('DATA_DIR', './data'),
  };
}
