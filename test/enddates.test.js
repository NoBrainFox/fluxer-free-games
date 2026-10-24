import assert from 'node:assert/strict';
import { test } from 'node:test';
import { endDateText } from '../src/embeds.js';
import { findEndDate, normalizeTitle, parseEpic, parseGamerPower } from '../src/enddates.js';
import { PostedState } from '../src/state.js';

const future = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
const gpDate = future.toISOString().slice(0, 19).replace('T', ' ');

const epicJson = {
  data: {
    Catalog: {
      searchStore: {
        elements: [
          {
            title: 'Sker Ritual™',
            promotions: {
              promotionalOffers: [
                {
                  promotionalOffers: [
                    { startDate: '2026-10-23T15:00:00.000Z', endDate: future.toISOString(), discountSetting: { discountPercentage: 0 } },
                  ],
                },
              ],
            },
          },
          {
            title: 'Discounted Only',
            promotions: {
              promotionalOffers: [
                { promotionalOffers: [{ endDate: future.toISOString(), discountSetting: { discountPercentage: 20 } }] },
              ],
            },
          },
          { title: 'No Promo', promotions: null },
        ],
      },
    },
  },
};

const gamerPowerJson = [
  { title: 'Some Game (GOG) Giveaway', platforms: 'PC, GOG', end_date: gpDate, status: 'Active' },
  { title: 'Some Game (Steam) Giveaway', platforms: 'PC, Steam', end_date: gpDate, status: 'Active' },
  { title: 'Unknown End (Steam) Giveaway', platforms: 'PC, Steam', end_date: 'N/A', status: 'Active' },
];

test('normalizeTitle strips store tags, trademarks and punctuation', () => {
  assert.equal(normalizeTitle('Sker Ritual™ (Epic Games) Giveaway'), 'sker ritual');
  assert.equal(normalizeTitle("Tom Clancy's: The Division"), 'tom clancy s the division');
});

test('parseEpic keeps only 100% off promotions', () => {
  assert.deepEqual(parseEpic(epicJson).map((e) => e.title), ['sker ritual']);
});

test('parseGamerPower skips N/A end dates and reads dates as UTC', () => {
  const parsed = parseGamerPower(gamerPowerJson);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].endsAt.toISOString().slice(0, 19), future.toISOString().slice(0, 19));
});

test('findEndDate uses Epic for Epic games and matches the store on GamerPower', async () => {
  globalThis.fetch = async (url) =>
    new Response(JSON.stringify(String(url).includes('epicgames') ? epicJson : gamerPowerJson));
  const epic = await findEndDate('Sker Ritual', 'Epic Games Store');
  assert.equal(epic.source, 'epic');
  const gog = await findEndDate('Some Game', 'GOG');
  assert.equal(gog.source, 'gamerpower');
  assert.match(gog.platforms, /gog/);
  assert.equal(await findEndDate('Unknown End', 'Steam'), null);
});

test('endDateText renders timestamp tags and credits GamerPower', () => {
  const endsAt = new Date('2026-11-01T17:00:00Z');
  assert.equal(endDateText({ endsAt, source: 'epic' }), '<t:1793552400:f> (<t:1793552400:R>)');
  assert.equal(
    endDateText({ endsAt, source: 'gamerpower' }, 'text'),
    'Sun, 01 Nov 2026 17:00 UTC · via [GamerPower](https://www.gamerpower.com)',
  );
});

test('posts with a passed end date count as expired even while still listed', () => {
  const state = new PostedState('/nonexistent');
  const now = Date.now();
  state.markPosted('ended', { channelId: 'c', messageId: 'm', endsAt: now - 1000 }, now - 5000);
  state.markPosted('running', { channelId: 'c', messageId: 'm2', endsAt: now + 100000 }, now - 5000);
  state.touch(['ended', 'running'], now);
  assert.deepEqual(state.expired(2 * 60 * 60 * 1000, now).map(([id]) => id), ['ended']);
  state.forgetMessage('ended');
  assert.equal(state.has('ended'), true);
  assert.equal(state.expired(2 * 60 * 60 * 1000, now).length, 0);
});
