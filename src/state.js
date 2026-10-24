// Remembers which deals were already announced so restarts never repost them.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// A deal that has not been free for this long is forgotten, so a later giveaway
// of the same game gets announced again.
const FORGET_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

export class PostedState {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = join(dataDir, 'posted.json');
    this.initialized = false;
    this.deals = {};
  }

  async load() {
    await mkdir(this.dataDir, { recursive: true });
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8'));
      this.initialized = Boolean(saved.initialized);
      this.deals = saved.deals ?? {};
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`[state] could not read ${this.file}, starting fresh:`, err.message);
    }
  }

  has(dealID) {
    return dealID in this.deals;
  }

  // message ({ channelId, messageId }) is kept so the post can be deleted once the deal expires.
  markPosted(dealID, message, now = Date.now()) {
    this.deals[dealID] = { postedAt: now, lastSeen: now, ...message };
  }

  // Posted deals that have not been free for longer than graceMs. Call after touch().
  expired(graceMs, now = Date.now()) {
    return Object.entries(this.deals).filter(([, entry]) => entry.messageId && now - entry.lastSeen > graceMs);
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
