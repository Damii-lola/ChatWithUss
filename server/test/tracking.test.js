import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/app.js';
import { orderView, normalizeOrderNumber, normalizeEmail } from '../src/services/tracking.js';
import { embedEnabledFromSettings } from '../src/services/widgetStatus.js';
import { createRateLimiter } from '../src/lib/rateLimit.js';
import { testConfig, memoryStore, fakeShopify, silentLogger, sessionToken, signProxyQuery, SHOP } from './helpers.js';

// ---------------------------------------------------------------- fixtures
const li = (id, title, qty, variant = 'M / Blue') => ({ id: `gid://shopify/LineItem/${id}`, title, variantTitle: variant, quantity: qty, image: { url: `https://cdn.shopify.com/${id}.jpg`, altText: null } });
const ful = (over = {}) => ({
  id: 'gid://shopify/Fulfillment/1',
  status: 'SUCCESS',
  displayStatus: 'IN_TRANSIT',
  createdAt: '2026-09-20T10:00:00Z',
  updatedAt: '2026-09-21T10:00:00Z',
  inTransitAt: '2026-09-21T10:00:00Z',
  deliveredAt: null,
  estimatedDeliveryAt: '2026-09-30T18:00:00Z',
  trackingInfo: [{ company: 'DHL Express', number: 'JD014600003SE', url: 'https://www.dhl.com/track?id=JD014600003SE' }],
  fulfillmentLineItems: { nodes: [{ quantity: 2, lineItem: { id: 'gid://shopify/LineItem/1' } }] },
  ...over,
});
const order = (over = {}) => ({
  id: 'gid://shopify/Order/555',
  name: '#1001',
  email: 'Jane@Example.com',
  processedAt: '2026-09-19T09:00:00Z',
  cancelledAt: null,
  displayFulfillmentStatus: 'FULFILLED',
  displayFinancialStatus: 'PAID',
  statusPageUrl: 'https://demo-store.myshopify.com/123/orders/abc/authenticate?key=xyz',
  customer: { id: 'gid://shopify/Customer/77' },
  totalPriceSet: { presentmentMoney: { amount: '59.90', currencyCode: 'USD' } },
  lineItems: { nodes: [li(1, 'Classic Tee', 2)] },
  fulfillments: [ful()],
  ...over,
});

// ---------------------------------------------------------------- pure logic
test('order number + email normalisation', () => {
  assert.equal(normalizeOrderNumber(' #1001 '), '1001');
  assert.equal(normalizeOrderNumber('##SH-1001'), 'sh-1001');
  assert.equal(normalizeOrderNumber('10 01'), '1001');
  assert.equal(normalizeOrderNumber('1001" OR 1=1'), null);
  assert.equal(normalizeOrderNumber(''), null);
  assert.equal(normalizeOrderNumber(42), null);
  assert.equal(normalizeEmail(' Jane@Example.COM '), 'jane@example.com');
  assert.equal(normalizeEmail('nope'), null);
});

test('orderView: in transit with ETA, carrier, items, no private data', () => {
  const v = orderView(order());
  assert.equal(v.stage, 2);
  assert.equal(v.headline, "It's on the way");
  assert.equal(v.detail, 'with DHL Express');
  assert.equal(v.eta, '2026-09-30T18:00:00Z');
  assert.equal(v.shipments[0].tracking_number, 'JD014600003SE');
  assert.equal(v.shipments[0].item_count, 2);
  assert.equal(v.items[0].variant, 'M / Blue');
  assert.deepEqual(v.total, { amount: '59.90', currency: 'USD' });
  const json = JSON.stringify(v);
  assert.equal(json.includes('Jane@Example.com'), false, 'email never returned');
  assert.equal(json.includes('Customer/77'), false);
});

test('orderView: unfulfilled, delivered, cancelled, partial, delivery issue, stale status', () => {
  const unf = orderView(order({ fulfillments: [], displayFulfillmentStatus: 'UNFULFILLED' }));
  assert.equal(unf.stage, 0);
  assert.equal(unf.headline, "We're preparing your order");

  const del = orderView(order({ fulfillments: [ful({ displayStatus: 'DELIVERED', deliveredAt: '2026-09-25T12:00:00Z' })] }));
  assert.equal(del.stage, 3);
  assert.equal(del.headline, 'Delivered');
  assert.equal(del.delivered_at, '2026-09-25T12:00:00Z');
  assert.equal(del.eta, null);

  const stale = orderView(order({ fulfillments: [ful({ displayStatus: 'FULFILLED', deliveredAt: '2026-09-25T12:00:00Z' })] }));
  assert.equal(stale.stage, 3, 'carrier delivered timestamp beats stale display status');

  const can = orderView(order({ cancelledAt: '2026-09-19T12:00:00Z' }));
  assert.equal(can.cancelled, true);
  assert.equal(can.headline, 'This order was cancelled');
  assert.equal(can.eta, null);

  const part = orderView(order({ displayFulfillmentStatus: 'PARTIALLY_FULFILLED', lineItems: { nodes: [li(1, 'Tee', 2), li(2, 'Cap', 1, 'Default Title')] } }));
  assert.equal(part.partial, true);
  assert.equal(part.items[1].variant, null, '"Default Title" hidden');

  const issue = orderView(order({ fulfillments: [ful({ displayStatus: 'ATTEMPTED_DELIVERY' }), ful({ id: 'f2', displayStatus: 'DELIVERED', deliveredAt: '2026-09-25T12:00:00Z' })] }));
  assert.equal(issue.headline, 'Delivery was attempted', 'problems surface first');

  const voided = orderView(order({ fulfillments: [ful({ displayStatus: 'LABEL_VOIDED' })], displayFulfillmentStatus: 'UNFULFILLED' }));
  assert.equal(voided.shipments.length, 0);
  assert.equal(voided.stage, 0);
});

test('embedEnabledFromSettings', () => {
  const on = '/* x */ {"current":{"blocks":{"123":{"type":"shopify://apps/chatwithuss/blocks/chat-widget/9f1c","disabled":false}}}}';
  const off = '{"current":{"blocks":{"123":{"type":"shopify://apps/chatwithuss/blocks/chat-widget/9f1c","disabled":true}}}}';
  const other = '{"current":{"blocks":{"1":{"type":"shopify://apps/other/blocks/reviews/1"}}}}';
  assert.equal(embedEnabledFromSettings(on), true);
  assert.equal(embedEnabledFromSettings(off), false);
  assert.equal(embedEnabledFromSettings(other), false);
  assert.equal(embedEnabledFromSettings('{"current":{}}'), false);
  assert.equal(embedEnabledFromSettings('garbage'), null);
});

test('rate limiter', () => {
  let now = 0;
  const rl = createRateLimiter({ limit: 2, windowMs: 1000, clock: () => now });
  assert.equal(rl.hit('a').ok, true);
  assert.equal(rl.hit('a').ok, true);
  const third = rl.hit('a');
  assert.equal(third.ok, false);
  assert.equal(third.retryAfter, 1);
  now = 1001;
  assert.equal(rl.hit('a').ok, true);
});

// ---------------------------------------------------------------- HTTP
let server;
let base;
let store;
let shopify;
const S = { orders: [order()], hideEmail: false, metafields: [], embedOn: true };

before(async () => {
  store = memoryStore();
  const fake = fakeShopify();
  shopify = fake;
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    const q = body?.query || '';
    if (String(url).includes('/admin/api/') && q.includes('ChatWithUssFindOrders')) {
      fake.calls.push({ url: String(url), body });
      let nodes = S.orders;
      const v = body.variables.q;
      if (v.startsWith('customer_id:')) nodes = nodes.filter((o) => o.customer.id.endsWith(`/${v.split(':')[1]}`));
      else {
        const n = v.match(/^name:"(.*)"$/)[1];
        nodes = nodes.filter((o) => o.name.replace('#', '').toLowerCase().includes(n));
      }
      if (S.hideEmail) {
        return json({
          data: { orders: { nodes: nodes.map((o) => ({ ...o, email: null })) } },
          errors: [{ message: 'This app is not approved to access the Order object. See https://partners.shopify.com/ for more details.', path: ['orders', 'nodes', 0, 'email'] }],
        });
      }
      return json({ data: { orders: { nodes } } });
    }
    if (q.includes('ChatWithUssInstallation')) return json({ data: { currentAppInstallation: { id: 'gid://shopify/AppInstallation/9' } } });
    if (q.includes('ChatWithUssSetWidgetConfig')) {
      S.metafields.push(body.variables.metafields[0]);
      return json({ data: { metafieldsSet: { metafields: [{ id: 'gid://shopify/Metafield/1' }], userErrors: [] } } });
    }
    if (q.includes('ChatWithUssEmbedStatus')) {
      const content = JSON.stringify({ current: { blocks: { a: { type: 'shopify://apps/chatwithuss/blocks/chat-widget/abc', disabled: !S.embedOn } } } });
      return json({ data: { themes: { nodes: [{ id: 't', name: 'Dawn', files: { nodes: [{ body: { content } }] } }] } } });
    }
    return fake.fetchImpl(url, init);
  };
  const { app } = createApp({ config: testConfig(), store, logger: silentLogger, fetchImpl });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  // install the shop
  const res = await fetch(`${base}/api/me`, { headers: { Authorization: `Bearer ${sessionToken()}` } });
  assert.equal(res.status, 200);
});
after(() => new Promise((r) => server.close(r)));

const proxy = (path, { method = 'GET', body, customer = '', ip = '203.0.113.7' } = {}) => {
  const q = signProxyQuery({ shop: SHOP, path_prefix: '/apps/chatwithuss', timestamp: String(Math.floor(Date.now() / 1000)), logged_in_customer_id: customer });
  return fetch(`${base}/proxy${path}?${q}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: body ? JSON.stringify(body) : undefined,
  });
};
const authed = (p, init = {}) => fetch(base + p, { ...init, headers: { Authorization: `Bearer ${sessionToken()}`, 'Content-Type': 'application/json' } });

test('widget config is published to the app-data metafield, only when it changes', async () => {
  await new Promise((r) => setTimeout(r, 50)); // background sync from /api/me
  assert.equal(S.metafields.length, 1);
  const mf = S.metafields[0];
  assert.equal(mf.ownerId, 'gid://shopify/AppInstallation/9');
  assert.equal(mf.namespace, 'chatwithuss');
  assert.equal(mf.key, 'widget');
  assert.equal(mf.type, 'json');
  const cfg = JSON.parse(mf.value);
  assert.equal(cfg.brand_color, '#0A3D62');
  assert.equal(cfg.features.tracking, true);
  assert.equal(cfg.features.returns, false, 'unreleased features stay off on storefronts');

  await authed('/api/me');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(S.metafields.length, 1, 'unchanged config → no write');

  const save = await authed('/api/settings', { method: 'PUT', body: JSON.stringify({ greeting: 'Where can we help?' }) });
  const body = await save.json();
  assert.equal(body.published, true);
  assert.equal(S.metafields.length, 2);
  assert.equal(JSON.parse(S.metafields[1].value).greeting, 'Where can we help?');
});

test('widget-status reflects the theme app embed', async () => {
  let r = await (await authed('/api/widget-status')).json();
  assert.deepEqual({ live: r.live, embed: r.embed_enabled, theme: r.theme }, { live: true, embed: true, theme: 'Dawn' });
  S.embedOn = false;
  r = await (await authed('/api/widget-status')).json();
  assert.equal(r.live, false);
  assert.equal(r.embed_enabled, false);
  S.embedOn = true;
  const me = await (await authed('/api/me')).json();
  assert.deepEqual(me.live_features, { tracking: true, returns: false, ai: false });
});

test('track: guest with correct number + email gets the order and a stat is recorded', async () => {
  const before = store._data.events.filter((e) => e.type === 'tracking_lookup').length;
  const res = await proxy('/track', { method: 'POST', body: { order: '#1001', email: 'jane@example.com ' } });
  assert.equal(res.status, 200);
  const { order: o } = await res.json();
  assert.equal(o.name, '#1001');
  assert.equal(o.stage, 2);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(store._data.events.filter((e) => e.type === 'tracking_lookup').length, before + 1);
});

test('track: wrong email and unknown number give the SAME not-found answer', async () => {
  const a = await proxy('/track', { method: 'POST', body: { order: '1001', email: 'attacker@evil.com' }, ip: '198.51.100.1' });
  const b = await proxy('/track', { method: 'POST', body: { order: '9999', email: 'jane@example.com' }, ip: '198.51.100.1' });
  assert.equal(a.status, 404);
  assert.equal(b.status, 404);
  assert.deepEqual(await a.json(), await b.json());
});

test('track: validation errors', async () => {
  const res = await proxy('/track', { method: 'POST', body: { order: '', email: 'nope' } });
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.ok(body.errors.order && body.errors.email);
});

test('track: logged-in customer opens own order without email, never someone else\'s', async () => {
  const mine = await proxy('/track', { method: 'POST', body: { order: '1001' }, customer: '77' });
  assert.equal(mine.status, 200);
  const notMine = await proxy('/track', { method: 'POST', body: { order: '1001' }, customer: '12345' });
  assert.equal(notMine.status, 404, 'not their order → same not-found answer as any miss');
  const notMine2 = await proxy('/track', { method: 'POST', body: { order: '1001', email: 'x@y.co' }, customer: '12345' });
  assert.equal(notMine2.status, 404);
});

test('orders: logged-in list; guests rejected', async () => {
  const r = await proxy('/orders', { customer: '77' });
  assert.equal(r.status, 200);
  const { orders } = await r.json();
  assert.equal(orders.length, 1);
  assert.equal(orders[0].name, '#1001');
  assert.equal(orders[0].item_count, 2);
  assert.equal((await proxy('/orders')).status, 401);
});

test('track: protected customer data not approved → friendly 503, not a false "not found"', async () => {
  S.hideEmail = true;
  const res = await proxy('/track', { method: 'POST', body: { order: '1001', email: 'jane@example.com' }, ip: '192.0.2.50' });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'unavailable');
  S.hideEmail = false;
});

test('track: brute force on one order number is locked out even across IPs', async () => {
  S.orders = [order({ name: '#2002', id: 'gid://shopify/Order/2002' })];
  let last;
  for (let i = 0; i < 7; i++) {
    last = await proxy('/track', { method: 'POST', body: { order: '2002', email: `guess${i}@x.io` }, ip: `10.0.0.${i}` });
  }
  assert.equal(last.status, 429);
  assert.ok(Number(last.headers.get('retry-after')) > 0);
  // even the right email is blocked during lockout
  const right = await proxy('/track', { method: 'POST', body: { order: '2002', email: 'jane@example.com' }, ip: '10.0.0.99' });
  assert.equal(right.status, 429);
});

test('track: per-visitor limit', async () => {
  S.orders = [order()];
  let last;
  for (let i = 0; i < 21; i++) last = await proxy('/track', { method: 'POST', body: { order: '1001', email: 'jane@example.com' }, ip: '172.16.0.1' });
  assert.equal(last.status, 429);
});
