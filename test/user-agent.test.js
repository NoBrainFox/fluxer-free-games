import assert from 'node:assert/strict';
import { test } from 'node:test';

test('CheapShark requests carry CONTACT_EMAIL in the User-Agent', async () => {
  process.env.CONTACT_EMAIL = 'bot-admin@example.com';
  const { getStores } = await import('../src/cheapshark.js');
  let userAgent;
  globalThis.fetch = async (_url, init) => {
    userAgent = init.headers['User-Agent'];
    return new Response('[]');
  };
  await getStores();
  assert.equal(userAgent, 'fluxer-freegames-bot/1.0 (+https://github.com/NoBrainFox/fluxer-free-games; bot-admin@example.com)');
});
