import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createApp } from '../src/app.js';
import { testConfig, memoryStore, fakeShopify, silentLogger, sessionToken, webhookHmac, signProxyQuery, SHOP, API_KEY } from './helpers.js';

let server;
let base;
let store;
let fake;

before(async () => {
  store = memoryStore();
  fake = fakeShopify();
  const { app } = createApp({ config: testConfig(), store, logger: silentLogger, fetchImpl: fake.fetchImpl });
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));

const authed = (path, init = {}) =>
  fetch(base + path, { ...init, headers: { Authorization: `Bearer ${sessionToken()}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });

function sendWebhook(topic, payload, { id = crypto.randomUUID(), hmac, shop = SHOP, path = '/webhooks' } = {}) {
  const body = JSON.stringify(payload);
  return fetch(base + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Topic': topic,
      'X-Shopify-Shop-Domain': shop,
      'X-Shopify-Webhook-Id': id,
      'X-Shopify-Hmac-Sha256': hmac ?? webhookHmac(body),
    },
    body,
  });
}

// ---------------------------------------------------------------- shell & health
test('healthz', async () => {
  assert.deepEqual(await (await fetch(`${base}/healthz`)).json(), { ok: true });
  assert.deepEqual(await (await fetch(`${base}/healthz?deep=1`)).json(), { ok: true, db: 'ok' });
});

test('dashboard shell: api key injected, frame-ancestors locked to the shop, assets versioned', async () => {
  const res = await fetch(`${base}/?shop=${SHOP}&host=abc&embedded=1`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-security-policy'), `frame-ancestors https://${SHOP} https://admin.shopify.com;`);
  assert.equal(res.headers.get('x-powered-by'), null);
  const html = await res.text();
  assert.ok(html.includes(`<meta name="shopify-api-key" content="${API_KEY}" />`));
  assert.ok(html.indexOf('app-bridge.js') < html.indexOf('app.css'), 'App Bridge is the first resource');
  assert.match(html, /\/assets\/app\.js\?v=[0-9a-f]{10}/);
  assert.ok(!html.includes('{{'), 'no unrendered template tokens');

  const bad = await fetch(`${base}/settings?shop=evil.com`);
  assert.equal(bad.headers.get('content-security-policy'), 'frame-ancestors https://*.myshopify.com https://admin.shopify.com;');

  const js = await fetch(`${base}/assets/app.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
});

test('legacy auth callback bounces back into the embedded app', async () => {
  const res = await fetch(`${base}/auth/callback?shop=${SHOP}&code=x`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), `https://${SHOP}/admin/apps/${API_KEY}`);
  assert.equal((await fetch(`${base}/auth/callback?shop=evil.com`, { redirect: 'manual' })).status, 400);
});

// ---------------------------------------------------------------- API auth + onboarding
test('/api rejects missing / forged tokens with the App Bridge retry header', async () => {
  const none = await fetch(`${base}/api/me`);
  assert.equal(none.status, 401);
  assert.equal(none.headers.get('x-shopify-retry-invalid-session-request'), '1');
  const forged = await fetch(`${base}/api/me`, { headers: { Authorization: `Bearer ${sessionToken({ secret: 'forged' })}` } });
  assert.equal(forged.status, 401);
});

test('first /api/me installs the shop, pulls identity + brand, returns dashboard data', async () => {
  const res = await authed('/api/me');
  assert.equal(res.status, 200);
  const me = await res.json();
  assert.equal(me.shop.name, 'Demo Store');
  assert.equal(me.shop.currency, 'USD');
  assert.equal(me.shop.primary_domain, 'demo.test');
  assert.equal(me.settings.brand_color, '#0A3D62');
  assert.equal(me.settings.accent_color, '#F39C12');
  assert.equal(me.settings.logo_url, 'https://cdn.shopify.com/s/files/logo.png');
  assert.equal(me.settings.brand_source, 'auto');
  assert.equal(me.app.theme_editor_url, `https://${SHOP}/admin/themes/current/editor?context=apps&activateAppId=${API_KEY}/chat-widget`);
  assert.ok(me.shop.trial_ends_at);
  assert.equal(JSON.stringify(me).includes('access_token'), false, 'no secrets to the browser');
});

test('stats endpoint computes deflection and hours saved', async () => {
  const shop = store._data.shops.get(SHOP);
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 40 * 86400000).toISOString();
  for (let i = 0; i < 12; i++) store._data.events.push({ shop_id: shop.id, type: 'tracking_lookup', created_at: now });
  for (let i = 0; i < 3; i++) store._data.events.push({ shop_id: shop.id, type: 'ai_answer', created_at: now });
  store._data.events.push({ shop_id: shop.id, type: 'agent_reply', created_at: now });
  store._data.events.push({ shop_id: shop.id, type: 'tracking_lookup', created_at: old });
  store._data.conversations.push({ id: 'c-open', shop_id: shop.id, needs_human: true, status: 'open' });
  store._data.returns.push({ id: 'r-pending', shop_id: shop.id, status: 'pending', customer_email: 'x@y.z', order_id: '1' });

  const s = await (await authed('/api/stats?days=30')).json();
  assert.equal(s.total, 16);
  assert.equal(s.deflected, 15);
  assert.equal(s.minutes_saved, 60);
  assert.equal(s.hours_saved, 1);
  assert.equal(s.by_type.tracking_lookup, 12);
  assert.equal(s.open_conversations, 1);
  assert.equal(s.pending_returns, 1);
  store._data.conversations.length = 0;
  store._data.returns.length = 0;
});

test('settings: valid patch saves + flips brand to custom; invalid gets 422 with field errors', async () => {
  const ok = await authed('/api/settings', { method: 'PUT', body: JSON.stringify({ accent_color: '#10b981', greeting: 'Need a hand?', return_window_days: 14 }) });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.settings.accent_color, '#10B981');
  assert.equal(body.settings.brand_source, 'custom');
  assert.equal(body.settings.return_window_days, 14);
  assert.ok(body.settings.settings_saved_at);
  assert.equal(body.widget_preview.greeting, 'Need a hand?');
  assert.equal(body.settings.brand_color, '#0A3D62', 'untouched keys preserved');

  const bad = await authed('/api/settings', { method: 'PUT', body: JSON.stringify({ accent_color: 'blue', return_window_days: 999 }) });
  assert.equal(bad.status, 422);
  const errs = (await bad.json()).errors;
  assert.ok(errs.accent_color && errs.return_window_days);

  const junk = await authed('/api/settings', { method: 'PUT', body: '{not json' });
  assert.equal(junk.status, 400);
});

test('brand re-sync overwrites custom colors from the store', async () => {
  const res = await authed('/api/brand/sync', { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.brand_found, true);
  assert.equal(body.settings.accent_color, '#F39C12');
  assert.equal(body.settings.brand_source, 'auto');
  assert.equal(body.settings.greeting, 'Need a hand?', 'non-brand settings kept');
});

test('unknown /api route → JSON 404', async () => {
  const res = await authed('/api/nope');
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'not_found' });
});

// ---------------------------------------------------------------- app proxy
test('app proxy: signed request gets public config; unsigned/stale/uninstalled rejected', async () => {
  const ts = Math.floor(Date.now() / 1000);
  const q = signProxyQuery({ shop: SHOP, path_prefix: '/apps/chatwithuss', timestamp: String(ts), logged_in_customer_id: '' });
  const res = await fetch(`${base}/proxy/config?${q}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.config.shop_name, 'Demo Store');
  assert.equal(body.config.features.tracking, true);
  assert.equal(body.config.features.returns, false, 'returns not live yet (Phase 4)');
  assert.equal(body.customer.logged_in, false);
  assert.equal(JSON.stringify(body).includes('owner@demo.test'), false);

  const tampered = q.replace(`timestamp=${ts}`, `timestamp=${ts + 1}`);
  assert.equal((await fetch(`${base}/proxy/config?${tampered}`)).status, 401);

  const stale = signProxyQuery({ shop: SHOP, path_prefix: '/apps/chatwithuss', timestamp: String(ts - 3600) });
  assert.equal((await fetch(`${base}/proxy/config?${stale}`)).status, 401);

  const other = signProxyQuery({ shop: 'not-installed.myshopify.com', path_prefix: '/apps/chatwithuss', timestamp: String(ts) });
  assert.equal((await fetch(`${base}/proxy/config?${other}`)).status, 404);
});

// ---------------------------------------------------------------- webhooks
test('webhooks: bad HMAC → 401', async () => {
  const res = await sendWebhook('app/uninstalled', { id: 1 }, { hmac: 'bogus' });
  assert.equal(res.status, 401);
});

test('webhooks: scopes_update and legacy per-topic paths', async () => {
  const res = await sendWebhook('app/scopes_update', { current: ['read_orders', 'write_orders'] }, { path: '/webhooks/app/scopes_update' });
  assert.equal(res.status, 200);
  assert.equal(store._data.shops.get(SHOP).scopes, 'read_orders,write_orders');
});

test('webhooks: customers/data_request exports, customers/redact deletes (email, customer id, order GIDs)', async () => {
  const shop = store._data.shops.get(SHOP);
  store._data.conversations.push(
    { id: 'c1', shop_id: shop.id, customer_email: 'Jane@Example.com', status: 'open' },
    { id: 'c2', shop_id: shop.id, shopify_customer_id: 'gid://shopify/Customer/77', status: 'open' },
    { id: 'c3', shop_id: shop.id, order_id: 'gid://shopify/Order/555', status: 'open' },
    { id: 'c4', shop_id: shop.id, customer_email: 'someone@else.com', status: 'open' },
  );
  store._data.messages.push({ id: 'm1', conversation_id: 'c1', body: 'where is my order' }, { id: 'm4', conversation_id: 'c4', body: 'keep me' });
  store._data.returns.push({ id: 'r1', shop_id: shop.id, customer_email: 'jane@example.com', order_id: 'gid://shopify/Order/555', status: 'pending' });

  const customer = { id: 77, email: 'jane@example.com', phone: null };
  const dr = await sendWebhook('customers/data_request', { shop_domain: SHOP, customer, orders_requested: [555], data_request: { id: 9 } });
  assert.equal(dr.status, 200);
  const exported = store._data.compliance.find((c) => c.topic === 'customers/data_request');
  assert.deepEqual(exported.result.counts, { conversations: 3, messages: 1, returns: 1 });

  const rd = await sendWebhook('customers/redact', { shop_domain: SHOP, customer, orders_to_redact: [555] });
  assert.equal(rd.status, 200);
  assert.deepEqual(store._data.conversations.map((c) => c.id), ['c4']);
  assert.deepEqual(store._data.messages.map((m) => m.id), ['m4']);
  assert.equal(store._data.returns.length, 0);
  assert.deepEqual(exported.result, { scrubbed: true }, 'earlier export payload scrubbed');
  const log = store._data.compliance.find((c) => c.topic === 'customers/redact');
  assert.equal(JSON.stringify(log).includes('jane@example.com'), false, 'redaction log does not keep the email');
});

test('webhooks: duplicate delivery is processed once; failures release the claim for retry', async () => {
  const id = 'dup-webhook-1';
  let calls = 0;
  const original = store.updateShop;
  store.updateShop = async (...args) => {
    calls += 1;
    if (calls === 1) throw new Error('db blip');
    return original(...args);
  };
  const first = await sendWebhook('app/scopes_update', { current: ['read_orders'] }, { id });
  assert.equal(first.status, 500, 'failure → 500 so Shopify retries');
  const retry = await sendWebhook('app/scopes_update', { current: ['read_orders'] }, { id });
  assert.equal(retry.status, 200);
  const dup = await sendWebhook('app/scopes_update', { current: ['read_orders'] }, { id });
  assert.equal(dup.status, 200);
  assert.equal(calls, 2, 'duplicate not reprocessed');
  store.updateShop = original;
});

test('webhooks: unknown topic acknowledged; invalid JSON with valid HMAC → 400', async () => {
  assert.equal((await sendWebhook('orders/create', { id: 1 })).status, 200);
  const body = '{nope';
  const res = await fetch(`${base}/webhooks`, {
    method: 'POST',
    headers: { 'X-Shopify-Topic': 'app/uninstalled', 'X-Shopify-Shop-Domain': SHOP, 'X-Shopify-Hmac-Sha256': webhookHmac(body) },
    body,
  });
  assert.equal(res.status, 400);
});

test('webhooks: app/uninstalled wipes tokens; proxy then 404s; shop/redact deletes everything', async () => {
  assert.equal((await sendWebhook('app/uninstalled', { id: 1, domain: SHOP })).status, 200);
  const row = store._data.shops.get(SHOP);
  assert.ok(row.uninstalled_at);
  assert.equal(row.access_token_enc, null);
  assert.equal(row.refresh_token_enc, null);

  const q = signProxyQuery({ shop: SHOP, path_prefix: '/apps/chatwithuss', timestamp: String(Math.floor(Date.now() / 1000)) });
  assert.equal((await fetch(`${base}/proxy/config?${q}`)).status, 404);

  assert.equal((await sendWebhook('shop/redact', { shop_id: 1, shop_domain: SHOP })).status, 200);
  assert.equal(store._data.shops.has(SHOP), false);
  assert.equal(store._data.conversations.length, 0);
});

test('reinstall after uninstall works through the normal dashboard load', async () => {
  const res = await authed('/api/me');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).shop.name, 'Demo Store');
});
