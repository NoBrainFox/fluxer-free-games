import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { getFreeDeals, resolveStores } from '../src/cheapshark.js';
import { dealEmbed, mentionFor } from '../src/embeds.js';
import { PostedState } from '../src/state.js';

const stores = [
  { storeID: '1', storeName: 'Steam', isActive: 1, images: { icon: '/img/stores/icons/0.png' } },
  { storeID: '7', storeName: 'GOG', isActive: 1, images: { icon: '/img/stores/icons/6.png' } },
  { storeID: '25', storeName: 'Epic Games Store', isActive: 1, images: { icon: '/img/stores/icons/24.png' } },
];

test('resolveStores matches ids, names and partial names', () => {
  const { matched, unknown } = resolveStores(stores, ['1', 'gog', 'epic', 'nope']);
  assert.deepEqual(matched.map((s) => s.storeID), ['1', '7', '25']);
  assert.deepEqual(unknown, ['nope']);
  assert.equal(resolveStores(stores, ['all']).matched.length, 3);
});

test('mentionFor builds role, everyone and empty mentions', () => {
  assert.deepEqual(mentionFor('123'), { content: '<@&123>', allowed_mentions: { roles: ['123'] } });
  assert.deepEqual(mentionFor('<@&123>').content, '<@&123>');
  assert.equal(mentionFor('everyone').content, '@everyone');
  assert.equal(mentionFor('').content, undefined);
});

test('getFreeDeals keeps only temporarily free games', async () => {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(
      JSON.stringify([
        { dealID: 'a', title: 'Giveaway', storeID: '25', salePrice: '0.00', normalPrice: '19.99' },
        { dealID: 'b', title: 'F2P', storeID: '1', salePrice: '0.00', normalPrice: '0.00' },
        { dealID: 'c', title: 'Cheap', storeID: '1', salePrice: '0.99', normalPrice: '9.99' },
      ]),
      { headers: { 'x-total-page-count': '1' } },
    );
  };
  const deals = await getFreeDeals(['1', '25'], { fresh: true });
  assert.deepEqual(deals.map((d) => d.dealID), ['a']);
  assert.match(calls[0], /upperPrice=0/);
  assert.match(calls[0], /storeID=1%2C25/);
  const withF2P = await getFreeDeals(['1', '25'], { includeFreeToPlay: true, fresh: true });
  assert.deepEqual(withF2P.map((d) => d.dealID), ['a', 'b']);
});

test('dealEmbed uses Steam header art as preview', () => {
  const embed = dealEmbed(
    { dealID: 'x', title: 'Game', storeID: '1', salePrice: '0.00', normalPrice: '9.99', steamAppID: '42', thumb: 't.jpg', lastChange: '1700000000' },
    new Map(stores.map((s) => [s.storeID, s])),
  );
  assert.match(embed.image.url, /apps\/42\/header\.jpg/);
  assert.equal(embed.footer.text, 'Steam');
  assert.equal(embed.footer.icon_url, 'https://www.cheapshark.com/img/stores/icons/0.png');
});

test('PostedState persists and forgets old deals', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fg-'));
  const state = new PostedState(dir);
  await state.load();
  state.markPosted('old', undefined, 0);
  state.markPosted('new', undefined, Date.now());
  state.initialized = true;
  state.touch(['new']);
  await state.save();

  const reloaded = new PostedState(dir);
  await reloaded.load();
  assert.equal(reloaded.initialized, true);
  assert.equal(reloaded.has('new'), true);
  assert.equal(reloaded.has('old'), false);
});

test('dealUrl keeps CheapShark dealIDs as they are (already URL-encoded)', async () => {
  const { dealUrl } = await import('../src/cheapshark.js');
  assert.equal(
    dealUrl('4pPw8jLAD9zaeoJQbKVcx%2F2aYv0KnVTyK74UaA5QzB4%3D'),
    'https://www.cheapshark.com/redirect?dealID=4pPw8jLAD9zaeoJQbKVcx%2F2aYv0KnVTyK74UaA5QzB4%3D',
  );
});

test('PostedState lists posts whose deal has been gone longer than the grace period', () => {
  const state = new PostedState('/nonexistent');
  const hour = 60 * 60 * 1000;
  const now = 10 * hour;
  state.markPosted('gone', { channelId: 'c', messageId: 'm1' }, now - 3 * hour);
  state.markPosted('recent', { channelId: 'c', messageId: 'm2' }, now - 3 * hour);
  state.markPosted('noMessage', undefined, now - 3 * hour);
  state.touch(['recent'], now);
  assert.deepEqual(state.expired(2 * hour, now).map(([id]) => id), ['gone']);
  state.forget('gone');
  assert.equal(state.has('gone'), false);
});
