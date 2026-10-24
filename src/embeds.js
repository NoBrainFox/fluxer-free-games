import { assetUrl, dealUrl } from './cheapshark.js';

const COLOR = 0x2ecc71;
const MAX_LIST_ENTRIES = 25;

function money(value) {
  const amount = Number.parseFloat(value);
  return Number.isFinite(amount) ? `$${amount.toFixed(2)}` : '?';
}

function storeFooter(store) {
  if (!store) return undefined;
  return { text: store.storeName, icon_url: assetUrl(store.images?.icon) };
}

// A rich embed for a single free deal, with a large preview image when one is available.
// "Free until" value: Discord-style timestamps render in each viewer's timezone with a live countdown.
export function endDateText(end, style = 'discord') {
  const seconds = Math.floor(end.endsAt.getTime() / 1000);
  const when =
    style === 'text'
      ? `${end.endsAt.toUTCString().replace(':00 GMT', ' UTC')}`
      : `<t:${seconds}:f> (<t:${seconds}:R>)`;
  // GamerPower's terms require a link back when their data is shown.
  return end.source === 'gamerpower' ? `${when} · via [GamerPower](https://www.gamerpower.com)` : when;
}

export function dealEmbed(deal, storesById, end = null, endStyle = 'discord') {
  const store = storesById.get(deal.storeID);
  const fields = [
    { name: 'Price', value: `~~${money(deal.normalPrice)}~~ → **FREE**`, inline: true },
    { name: 'Store', value: store?.storeName ?? `Store ${deal.storeID}`, inline: true },
  ];
  if (end) fields.push({ name: 'Free until', value: endDateText(end, endStyle), inline: false });
  if (deal.steamRatingText && deal.steamRatingPercent !== '0') {
    fields.push({ name: 'Steam rating', value: `${deal.steamRatingText} (${deal.steamRatingPercent}%)`, inline: true });
  }
  if (deal.metacriticScore && deal.metacriticScore !== '0') {
    fields.push({ name: 'Metacritic', value: deal.metacriticScore, inline: true });
  }

  const embed = {
    title: deal.title,
    url: dealUrl(deal.dealID),
    description: `**${deal.title}** is free to keep on ${store?.storeName ?? 'this store'} right now.`,
    color: COLOR,
    fields,
    footer: storeFooter(store),
  };

  // Steam header art is a much nicer preview than CheapShark's small capsule thumbnail.
  if (deal.steamAppID) {
    embed.image = { url: `https://cdn.cloudflare.steamstatic.com/steam/apps/${deal.steamAppID}/header.jpg` };
    if (deal.thumb) embed.thumbnail = { url: deal.thumb };
  } else if (deal.thumb) {
    embed.image = { url: deal.thumb };
  }

  if (deal.lastChange) embed.timestamp = new Date(Number(deal.lastChange) * 1000).toISOString();
  return embed;
}

// A compact list of free deals for on-demand commands.
export function dealListEmbed(deals, storesById, title = 'Free games right now') {
  if (deals.length === 0) {
    return { title, description: 'No free games found for these stores right now.', color: COLOR };
  }
  const lines = deals.slice(0, MAX_LIST_ENTRIES).map((deal) => {
    const store = storesById.get(deal.storeID)?.storeName ?? `Store ${deal.storeID}`;
    return `• [${deal.title}](${dealUrl(deal.dealID)}) · ${store} · ~~${money(deal.normalPrice)}~~`;
  });
  if (deals.length > MAX_LIST_ENTRIES) lines.push(`…and ${deals.length - MAX_LIST_ENTRIES} more.`);
  const first = deals.find((deal) => deal.thumb);
  return {
    title,
    description: lines.join('\n'),
    color: COLOR,
    thumbnail: first ? { url: first.thumb } : undefined,
    footer: { text: 'Prices via CheapShark' },
  };
}

export function storesEmbed(allStores, configured) {
  const configuredIds = new Set(configured.map((s) => s.storeID));
  const lines = allStores.map((s) => `${configuredIds.has(s.storeID) ? '✅' : '▫️'} \`${s.storeID}\` ${s.storeName}`);
  return {
    title: 'CheapShark stores',
    description: `✅ = announced automatically\n\n${lines.join('\n')}`.slice(0, 4096),
    color: COLOR,
  };
}

export function helpEmbed(prefix, pollMinutes) {
  return {
    title: 'Free Games bot',
    color: COLOR,
    description: [
      `\`${prefix}free\` lists free games on the announced stores`,
      `\`${prefix}free <store>\` lists free games on one store, e.g. \`${prefix}free gog\``,
      `\`${prefix}free all\` lists free games on every store`,
      `\`${prefix}stores\` shows all stores and which ones are announced`,
      `\`${prefix}help\` shows this message`,
      '',
      '**For the community owner, Manage Server or Administrator**',
      `\`${prefix}subscribe [role]\` announces new free games in this channel, optionally pinging a role`,
      `\`${prefix}unsubscribe\` stops announcements in this channel`,
      `\`${prefix}channels\` lists every channel that gets announcements`,
      `\`${prefix}reload [ping]\` deletes the bot's messages here and reposts the current free games`,
      '',
      `New free games are checked every ${pollMinutes} minutes.`,
    ].join('\n'),
  };
}

// channels: [{ channelId, label, source }]
export function channelsEmbed(channels) {
  const lines = channels.map(
    (c) => `• <#${c.channelId}> (\`${c.channelId}\`) · ${c.label} · ${c.source === 'env' ? 'set in .env' : 'added by command'}`,
  );
  return {
    title: 'Announcement channels',
    description: (lines.join('\n') || 'No channels yet. Use the subscribe command in a channel to add it.').slice(0, 4096),
    color: COLOR,
  };
}

// Message content and allowed_mentions for the configured role ping.
export function mentionFor(mentionRole) {
  const value = mentionRole.trim();
  if (!value) return { content: undefined, allowed_mentions: { parse: [] } };
  const lower = value.toLowerCase();
  if (lower === 'everyone' || lower === '@everyone') {
    return { content: '@everyone', allowed_mentions: { parse: ['everyone'] } };
  }
  if (lower === 'here' || lower === '@here') {
    return { content: '@here', allowed_mentions: { parse: ['everyone'] } };
  }
  const id = value.replace(/[<@&>]/g, '');
  return { content: `<@&${id}>`, allowed_mentions: { roles: [id] } };
}
