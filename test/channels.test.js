import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ChannelList } from '../src/channels.js';
import { parseChannels } from '../src/config.js';
import { canManageGuild } from '../src/permissions.js';
import { PostedState } from '../src/state.js';

test('parseChannels reads channels with optional roles and the old single-channel settings', () => {
  assert.deepEqual(parseChannels('111:Free Games, 222 ,333:everyone'), [
    { channelId: '111', role: 'Free Games' },
    { channelId: '222', role: '' },
    { channelId: '333', role: 'everyone' },
  ]);
  assert.deepEqual(parseChannels('', '444', '55'), [{ channelId: '444', role: '55' }]);
  assert.equal(parseChannels('444:x', '444', 'y').length, 1);
  assert.throws(() => parseChannels('general:x'), /not a channel ID/);
});

test('ChannelList merges .env channels with saved ones and persists commands', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fg-'));
  const list = new ChannelList(dir, [{ channelId: '1', role: 'everyone' }]);
  await list.load();
  list.add('2', '42');
  list.add('1', '99'); // .env wins
  await list.save();

  const reloaded = new ChannelList(dir, [{ channelId: '1', role: 'everyone' }]);
  await reloaded.load();
  assert.deepEqual(
    reloaded.all().map(({ channelId, role, source }) => [channelId, role, source]),
    [['1', 'everyone', 'env'], ['2', '42', 'command']],
  );
  reloaded.remove('2');
  assert.equal(reloaded.get('2'), undefined);
});

test('PostedState tracks posts per channel and migrates single-channel data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fg-'));
  await writeFile(
    join(dir, 'posted.json'),
    JSON.stringify({
      initialized: true,
      deals: {
        a: { postedAt: 1, lastSeen: Date.now(), channelId: '9', messageId: 'm1' },
        b: { postedAt: 1, lastSeen: Date.now() },
      },
    }),
  );
  const state = new PostedState(dir);
  await state.load('9');
  assert.deepEqual(state.deals.a.channels, { 9: 'm1' });
  assert.deepEqual(state.deals.b.channels, { 9: null });
  assert.equal(state.postedIn('b', '9'), true);
  assert.equal(state.postedIn('b', '10'), false);

  state.markPosted('a', '10', 'm2');
  assert.deepEqual(state.messagesIn('10'), [['a', 'm2']]);
  state.forgetMessage('a', '10');
  assert.equal(state.postedIn('a', '10'), true);
  assert.deepEqual(state.messagesIn('10'), []);
});

test('only the owner, Administrator or Manage Server may manage channels', () => {
  const roles = [
    { id: 'g', name: '@everyone', permissions: '3072' },
    { id: 'mod', name: 'Mod', permissions: '32' },
    { id: 'admin', name: 'Admin', permissions: '8' },
    { id: 'fan', name: 'Fan', permissions: '2048' },
  ];
  const check = (userId, memberRoleIds) => canManageGuild({ guildId: 'g', ownerId: 'owner', userId, roles, memberRoleIds });
  assert.equal(check('owner', []), true);
  assert.equal(check('u', ['mod']), true);
  assert.equal(check('u', ['admin']), true);
  assert.equal(check('u', ['fan']), false);
  assert.equal(check('u', []), false);
});
