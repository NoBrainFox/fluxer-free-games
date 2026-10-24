// Sends messages with graceful degradation. Fluxer's message validation is not
// fully documented and differs between instances, so when a message is rejected
// as invalid we retry with progressively simpler variants and remember the first
// one that works.

const LEVELS = [
  { name: 'as is', apply: (body) => body },
  { name: 'without allowed_mentions', apply: ({ allowed_mentions: _, ...body }) => body },
  {
    name: 'without images',
    apply: ({ allowed_mentions: _, ...body }) => ({ ...body, embeds: body.embeds?.map(stripMedia) }),
  },
  { name: 'as plain text', apply: ({ allowed_mentions: _, embeds, ...body }) => toPlainText(body, embeds) },
];

let level = 0;

function stripMedia({ image: _i, thumbnail: _t, timestamp: _ts, footer, ...embed }) {
  return footer ? { ...embed, footer: { text: footer.text } } : embed;
}

function embedToText(embed) {
  const lines = [];
  if (embed.title) lines.push(`**${embed.title}**${embed.url ? ` <${embed.url}>` : ''}`);
  if (embed.description) lines.push(embed.description);
  for (const field of embed.fields ?? []) lines.push(`${field.name}: ${field.value}`);
  return lines.join('\n');
}

function toPlainText(body, embeds = []) {
  const content = [body.content, ...embeds.map(embedToText)].filter(Boolean).join('\n\n').slice(0, 4000);
  return { ...body, content };
}

function describe(err) {
  const raw = err.rawError ? JSON.stringify(err.rawError) : '';
  return `${err.status ?? ''} ${err.message.replace(/\s+/g, ' ')} ${raw}`.trim();
}

export async function sendMessage(api, channelId, body) {
  for (let current = level; current < LEVELS.length; current++) {
    try {
      const result = await api.channels.createMessage(channelId, LEVELS[current].apply(body));
      if (current !== level) {
        console.warn(`[send] Fluxer accepted the message ${LEVELS[current].name}; using that from now on`);
        level = current;
      }
      return result;
    } catch (err) {
      // Only an invalid body is worth retrying in a simpler form.
      if (err.status !== 400 || current === LEVELS.length - 1) throw err;
      console.warn(`[send] message ${LEVELS[current].name} rejected: ${describe(err)}`);
    }
  }
}
