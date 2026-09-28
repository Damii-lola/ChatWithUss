import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createCipher } from '../src/lib/crypto.js';
import { createShopifyAuth } from '../src/lib/shopify/auth.js';
import { createTokenManager, ReauthRequiredError } from '../src/lib/shopify/tokens.js';
import { createAdminClient } from '../src/lib/shopify/admin.js';
import { API_KEY, API_SECRET, SHOP, memoryStore, fakeShopify, silentLogger, sessionToken } from './helpers.js';

function setup({ clockStart = Date.now(), ...fakeOpts } = {}) {
  let now = clockStart;
  const clock = () => now;
  const fake = fakeShopify(fakeOpts);
  const store = memoryStore();
  const cipher = createCipher('an-encryption-key-that-is-long-enough');
  const auth = createShopifyAuth({ apiKey: API_KEY, apiSecret: API_SECRET, fetchImpl: fake.fetchImpl, clock });
  const tokens = createTokenManager({ store, cipher, auth, logger: silentLogger, clock });
  return { fake, store, cipher, tokens, advance: (ms) => (now += ms), clock };
}

test('first visit installs with an EXPIRING offline token, encrypted at rest', async () => {
  const { fake, store, tokens } = setup();
  const { shop, installed } = await tokens.ensureInstalled(SHOP, sessionToken());
  assert.equal(installed, true);

  const exchange = fake.calls.find((c) => c.path === '/admin/oauth/access_token');
  assert.equal(exchange.body.grant_type, 'urn:ietf:params:oauth:grant-type:token-exchange');
  assert.equal(exchange.body.requested_token_type, 'urn:shopify:params:oauth:token-type:offline-access-token');
  assert.equal(exchange.body.expiring, 1);

  const row = store._data.shops.get(SHOP);
  assert.ok(row.access_token_enc.startsWith('v1.'));
  assert.ok(!JSON.stringify(row).includes('shpat_'), 'plaintext token never stored');
  assert.ok(row.refresh_token_enc && row.access_token_expires_at && row.refresh_token_expires_at && row.trial_ends_at);
  assert.equal(shop.shop_domain, SHOP);

  // Second visit: no extra exchange.
  const again = await tokens.ensureInstalled(SHOP, sessionToken());
  assert.equal(again.installed, false);
  assert.equal(fake.calls.filter((c) => c.path === '/admin/oauth/access_token').length, 1);
});

test('concurrent first requests trigger exactly one token exchange', async () => {
  const { fake, tokens } = setup();
  await Promise.all(Array.from({ length: 8 }, () => tokens.ensureInstalled(SHOP, sessionToken())));
  assert.equal(fake.calls.filter((c) => c.path === '/admin/oauth/access_token').length, 1);
});

test('access token is refreshed 5 minutes before expiry, rotating the refresh token', async () => {
  const { fake, store, tokens, cipher, advance } = setup();
  await tokens.ensureInstalled(SHOP, sessionToken());
  const first = await tokens.getAccessToken(SHOP);
  assert.equal(first, 'shpat_fake_1');

  advance(56 * 60 * 1000); // 56 minutes → inside the 5-min window
  const results = await Promise.all([tokens.getAccessToken(SHOP), tokens.getAccessToken(SHOP), tokens.getAccessToken(SHOP)]);
  assert.deepEqual(results, ['shpat_fake_2', 'shpat_fake_2', 'shpat_fake_2']);

  const refreshes = fake.calls.filter((c) => c.body?.grant_type === 'refresh_token');
  assert.equal(refreshes.length, 1, 'single-flight refresh');
  assert.equal(refreshes[0].body.refresh_token, 'shprt_fake_1');
  assert.equal(cipher.decrypt(store._data.shops.get(SHOP).refresh_token_enc), 'shprt_fake_2', 'rotated refresh token persisted');
});

test('revoked refresh token clears credentials and demands re-auth; next session token reinstalls', async () => {
  const { fake, store, tokens, advance } = setup();
  await tokens.ensureInstalled(SHOP, sessionToken());
  advance(61 * 60 * 1000);
  fake.state.refreshFails = true;

  await assert.rejects(tokens.getAccessToken(SHOP), ReauthRequiredError);
  assert.equal(store._data.shops.get(SHOP).access_token_enc, null);

  fake.state.refreshFails = false;
  const { installed } = await tokens.ensureInstalled(SHOP, sessionToken());
  assert.equal(installed, false, 're-auth of an existing shop is not a fresh install');
  assert.ok(await tokens.getAccessToken(SHOP));
});

test('a changed TOKEN_ENCRYPTION_KEY degrades to silent re-auth, not a crash', async () => {
  const { store, tokens, fake } = setup();
  await tokens.ensureInstalled(SHOP, sessionToken());
  const other = createTokenManager({
    store,
    cipher: createCipher('a-completely-different-encryption-key'),
    auth: createShopifyAuth({ apiKey: API_KEY, apiSecret: API_SECRET, fetchImpl: fake.fetchImpl }),
    logger: silentLogger,
  });
  await assert.rejects(other.getAccessToken(SHOP), ReauthRequiredError);
  const { shop } = await other.ensureInstalled(SHOP, sessionToken());
  assert.ok(shop.access_token_enc);
});

test('reinstall after uninstall is treated as a fresh install and keeps the original trial', async () => {
  const { store, tokens } = setup();
  await tokens.ensureInstalled(SHOP, sessionToken());
  const trial = store._data.shops.get(SHOP).trial_ends_at;
  await store.updateShop(SHOP, { uninstalled_at: new Date().toISOString(), access_token_enc: null });
  const { installed } = await tokens.ensureInstalled(SHOP, sessionToken());
  assert.equal(installed, true);
  assert.equal(store._data.shops.get(SHOP).uninstalled_at, null);
  assert.equal(store._data.shops.get(SHOP).trial_ends_at, trial, 'no second free trial by reinstalling');
});

test('non-expiring tokens (legacy) are supported', async () => {
  const { tokens } = setup({ expiring: false });
  await tokens.ensureInstalled(SHOP, sessionToken());
  assert.equal(await tokens.getAccessToken(SHOP), 'shpat_fake_1');
});

test('admin client: 401 forces one refresh + retry; 429 retries with backoff', async () => {
  const { fake, tokens } = setup();
  await tokens.ensureInstalled(SHOP, sessionToken());
  const sleeps = [];
  const admin = createAdminClient({ shop: SHOP, tokens, apiVersion: '2026-07', fetchImpl: fake.fetchImpl, logger: silentLogger, sleepImpl: async (ms) => sleeps.push(ms) });

  fake.state.validTokens.clear(); // current token rejected → 401
  const data = await admin.graphql('query ChatWithUssShop { shop { id } }');
  assert.equal(data.shop.name, 'Demo Store');
  assert.equal(fake.calls.filter((c) => c.body?.grant_type === 'refresh_token').length, 1);

  let hits = 0;
  const throttledFetch = async (url, init) => {
    if (String(url).includes('/graphql.json') && hits++ < 2) return new Response('{}', { status: 429, headers: { 'retry-after': '1' } });
    return fake.fetchImpl(url, init);
  };
  const admin2 = createAdminClient({ shop: SHOP, tokens, apiVersion: '2026-07', fetchImpl: throttledFetch, logger: silentLogger, sleepImpl: async (ms) => sleeps.push(ms) });
  assert.equal((await admin2.graphql('query ChatWithUssShop { shop { id } }')).shop.email, 'owner@demo.test');
  assert.deepEqual(sleeps.slice(-2), [1000, 1000]);
});
