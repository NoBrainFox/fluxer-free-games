// The channels that get announcements: the ones from .env plus the ones added with
// the subscribe command, which are saved so they survive restarts.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export class ChannelList {
  constructor(dataDir, fromEnv = []) {
    this.dataDir = dataDir;
    this.file = join(dataDir, 'channels.json');
    this.fromEnv = new Map(fromEnv.map((c) => [c.channelId, c.role]));
    this.saved = {};
  }

  async load() {
    await mkdir(this.dataDir, { recursive: true });
    try {
      this.saved = JSON.parse(await readFile(this.file, 'utf8')).channels ?? {};
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`[channels] could not read ${this.file}:`, err.message);
    }
  }

  // [{ channelId, role, source: 'env' | 'command' }]; a channel in .env wins over a saved one.
  all() {
    const result = [...this.fromEnv].map(([channelId, role]) => ({ channelId, role, source: 'env' }));
    for (const [channelId, entry] of Object.entries(this.saved)) {
      if (!this.fromEnv.has(channelId)) result.push({ channelId, role: entry.role ?? '', source: 'command' });
    }
    return result;
  }

  get(channelId) {
    return this.all().find((c) => c.channelId === channelId);
  }

  add(channelId, role, extra = {}) {
    this.saved[channelId] = { role, addedAt: Date.now(), ...extra };
  }

  remove(channelId) {
    delete this.saved[channelId];
  }

  async save() {
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify({ channels: this.saved }, null, 2));
    await rename(tmp, this.file);
  }
}
