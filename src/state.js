// Remembers which deals were already announced in which channel so restarts never repost them.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// A deal that has not been free for this long is forgotten, so a later giveaway
// of the same game gets announced again.
const FORGET_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

// Each deal is stored as { postedAt, lastSeen, endsAt?, channels: { channelId: messageId | null } }.
// A channel key means the deal was announced there; null means the post is gone or was never kept.
export class PostedState {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = join(dataDir, 'posted.json');
    this.initialized = false;
    this.deals = {};
  }

  // legacyChannelId: where deals saved by older versions (one channel only) were posted.
  async load(legacyChannelId = '') {
    await mkdir(this.dataDir, { recursive: true });
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8'));
      this.initialized = Boolean(saved.initialized);
      this.deals = saved.deals ?? {};
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`[state] could not read ${this.file}, starting fresh:`, err.message);
    }
    this.migrate(legacyChannelId);
  }

  migrate(legacyChannelId) {
    for (const entry of Object.values(this.deals)) {
      if (entry.channels) continue;
      const channelId = entry.channelId ?? legacyChannelId;
      entry.channels = channelId ? { [channelId]: entry.messageId ?? null } : {};
      delete entry.channelId;
      delete entry.messageId;
    }
  }

  has(dealID) {
    return dealID in this.deals;
  }

  postedIn(dealID, channelId) {
    return channelId in (this.deals[dealID]?.channels ?? {});
  }

  // messageId is kept so the post can be deleted once the deal expires (null if not kept).
  markPosted(dealID, channelId, messageId = null, extra = {}, now = Date.now()) {
    const entry = (this.deals[dealID] ??= { postedAt: now, lastSeen: now, channels: {} });
    Object.assign(entry, extra);
    if (channelId) entry.channels[channelId] = messageId;
  }

  // Posted deals that have not been free for longer than graceMs, or whose known end
  // date has passed, and still have a post somewhere. Call after touch().
  expired(graceMs, now = Date.now()) {
    return Object.entries(this.deals).filter(
      ([, entry]) =>
        Object.values(entry.channels).some(Boolean) &&
        (now - entry.lastSeen > graceMs || (entry.endsAt && now >= entry.endsAt)),
    );
  }

  // The post is gone, but keep the channel so the deal isn't announced there again.
  forgetMessage(dealID, channelId) {
    const channels = this.deals[dealID]?.channels;
    if (channels && channelId in channels) channels[channelId] = null;
  }

  // [[dealID, messageId]] for every known post in a channel.
  messagesIn(channelId) {
    return Object.entries(this.deals)
      .filter(([, entry]) => entry.channels[channelId])
      .map(([dealID, entry]) => [dealID, entry.channels[channelId]]);
  }

  forget(dealID) {
    delete this.deals[dealID];
  }

  // Refresh lastSeen for deals that are still free and drop long-gone ones.
  touch(currentDealIds, now = Date.now()) {
    for (const id of currentDealIds) if (this.deals[id]) this.deals[id].lastSeen = now;
    for (const [id, entry] of Object.entries(this.deals)) {
      if (now - entry.lastSeen > FORGET_AFTER_MS) delete this.deals[id];
    }
  }

  async save() {
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify({ initialized: this.initialized, deals: this.deals }, null, 2));
    await rename(tmp, this.file);
  }
}
