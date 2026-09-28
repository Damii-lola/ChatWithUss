import crypto from 'node:crypto';
import { idVariants } from '../src/db/store.js';

export const API_KEY = 'test_api_key_123';
export const API_SECRET = 'test_api_secret_456';
export const SHOP = 'demo-store.myshopify.com';

export function testConfig(overrides = {}) {
  return {
    appUrl: 'https://app.chatwithuss.test',
    port: 0,
    isProd: false,
    logLevel: 'silent',
    shopify: { apiKey: API_KEY, apiSecret: API_SECRET, apiVersion: '2026-07', scopes: [], widgetHandle: 'chat-widget' },
    supabase: { url: 'http://unused', serviceRoleKey: 'unused' },
    tokenEncryptionKey: 'an-encryption-key-that-is-long-enough',
    cloudflareAI: null,
    trialDays: 14,
    ...overrides,
  };
}

export const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

export function signJwt(payload, secret = API_SECRET) {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const s = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${s}`;
}

export function sessionToken({ shop = SHOP, exp = Math.floor(Date.now() / 1000) + 60, aud = API_KEY, secret = API_SECRET } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return signJwt(
    { iss: `https://${shop}/admin`, dest: `https://${shop}`, aud, sub: '42', exp, nbf: now - 5, iat: now - 5, jti: crypto.randomUUID(), sid: 'sid' },
    secret,
  );
}

export function webhookHmac(body, secret = API_SECRET) {
  return crypto.createHmac('sha256', secret).update(body).digest('base64');
}

export function signProxyQuery(params, secret = API_SECRET) {
  const keys = Object.keys(params).sort();
  const message = keys.map((k) => `${k}=${Array.isArray(params[k]) ? params[k].join(',') : params[k]}`).join('');
  const signature = crypto.createHmac('sha256', secret).update(message).digest('hex');
  const usp = new URLSearchParams();
  for (const k of keys) for (const v of [].concat(params[k])) usp.append(k, v);
  usp.append('signature', signature);
  return usp.toString();
}

/** In-memory implementation of the exact interface in src/db/store.js. */
export function memoryStore() {
  const shops = new Map();
  const webhooks = new Set();
  const compliance = [];
  const conversations = [];
  const messages = [];
  const returns = [];
  const events = [];

  const store = {
    _data: { shops, webhooks, compliance, conversations, messages, returns, events },
    async ping() { return true; },
    async getShop(d) { return shops.has(d) ? structuredClone(shops.get(d)) : null; },
    async upsertShop(d, fields) {
      const existing = shops.get(d);
      const row = existing
        ? { ...existing, ...fields }
        : { id: crypto.randomUUID(), shop_domain: d, plan: 'trial', billing_status: 'none', settings: {}, installed_at: new Date().toISOString(), uninstalled_at: null, shop_name: null, ...fields };
      shops.set(d, row);
      return structuredClone(row);
    },
    async updateShop(d, fields) {
      if (!shops.has(d)) return null;
      const row = { ...shops.get(d), ...fields };
      shops.set(d, row);
      return structuredClone(row);
    },
    async deleteShop(d) {
      const row = shops.get(d);
      if (!row) return 0;
      shops.delete(d);
      for (const list of [conversations, returns, events]) {
        for (let i = list.length - 1; i >= 0; i--) if (list[i].shop_id === row.id) list.splice(i, 1);
      }
      return 1;
    },
    async claimWebhook(id) {
      if (webhooks.has(id)) return false;
      webhooks.add(id);
      return true;
    },
    async releaseWebhook(id) { webhooks.delete(id); },
    async logCompliance(r) { compliance.push(structuredClone(r)); },
    async scrubCompliance(d, email = null) {
      for (const r of compliance) {
        if (r.shop_domain === d && r.topic === 'customers/data_request' && (!email || (r.customer_email || '').toLowerCase() === email.toLowerCase())) r.result = { scrubbed: true };
      }
    },
    async findCustomerData(shopId, { email, customerId, orderIds }) {
      const orders = idVariants(orderIds, 'Order');
      const customers = idVariants(customerId ? [customerId] : [], 'Customer');
      const em = email?.toLowerCase();
      const conv = conversations.filter((c) => c.shop_id === shopId && ((em && c.customer_email?.toLowerCase() === em) || customers.includes(c.shopify_customer_id) || orders.includes(c.order_id)));
      const ids = new Set(conv.map((c) => c.id));
      return {
        conversations: conv,
        messages: messages.filter((m) => ids.has(m.conversation_id)),
        returns: returns.filter((r) => r.shop_id === shopId && ((em && r.customer_email?.toLowerCase() === em) || orders.includes(r.order_id))),
      };
    },
    async redactCustomer(shopId, criteria) {
      const found = await store.findCustomerData(shopId, criteria);
      const convIds = new Set(found.conversations.map((c) => c.id));
      const retIds = new Set(found.returns.map((r) => r.id));
      for (let i = conversations.length - 1; i >= 0; i--) if (convIds.has(conversations[i].id)) conversations.splice(i, 1);
      for (let i = messages.length - 1; i >= 0; i--) if (convIds.has(messages[i].conversation_id)) messages.splice(i, 1);
      for (let i = returns.length - 1; i >= 0; i--) if (retIds.has(returns[i].id)) returns.splice(i, 1);
      return { conversations: convIds.size, messages: found.messages.length, returns: retIds.size };
    },
    async recordResolution(shopId, type) {
      events.push({ shop_id: shopId, type, created_at: new Date().toISOString() });
    },
    async countResolutions(shopId, since) {
      const out = {};
      for (const e of events) if (e.shop_id === shopId && e.created_at >= since) out[e.type] = (out[e.type] || 0) + 1;
      return out;
    },
    async countOpenConversations(shopId) {
      return conversations.filter((c) => c.shop_id === shopId && c.needs_human && c.status !== 'resolved').length;
    },
    async countPendingReturns(shopId) {
      return returns.filter((r) => r.shop_id === shopId && r.status === 'pending').length;
    },
  };
  return store;
}

/**
 * Fake Shopify: token endpoint, Admin GraphQL, Storefront GraphQL.
 * Records every call so tests can assert on exactly what we sent.
 */
export function fakeShopify({ brand = true, expiring = true, adminStatus = 200 } = {}) {
  const calls = [];
  let tokenCounter = 0;
  const state = { refreshFails: false, exchangeFails: null, adminStatus, validTokens: new Set() };

  const json = (status, body, headers = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

  async function fetchImpl(url, init = {}) {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), path: u.pathname, host: u.host, body, headers: init.headers || {} });

    if (u.pathname === '/admin/oauth/access_token') {
      if (body.client_id !== API_KEY || body.client_secret !== API_SECRET) return json(401, { error: 'invalid_client' });
      if (body.grant_type === 'refresh_token' && state.refreshFails) return json(400, { error: 'invalid_grant', error_description: 'refresh token revoked' });
      if (body.grant_type !== 'refresh_token' && state.exchangeFails) return json(400, { error: state.exchangeFails });
      tokenCounter += 1;
      const token = `shpat_fake_${tokenCounter}`;
      state.validTokens.add(token);
      return json(200, {
        access_token: token,
        scope: 'read_orders,write_orders',
        ...(expiring ? { expires_in: 3600, refresh_token: `shprt_fake_${tokenCounter}`, refresh_token_expires_in: 7776000 } : {}),
      });
    }

    if (u.pathname.startsWith('/admin/api/') && u.pathname.endsWith('/graphql.json')) {
      if (state.adminStatus !== 200) return json(state.adminStatus, { errors: 'nope' });
      if (!state.validTokens.has(init.headers['X-Shopify-Access-Token'])) return json(401, { errors: '[API] Invalid API key or access token' });
      if (body.query.includes('ChatWithUssShop')) {
        return json(200, { data: { shop: { id: 'gid://shopify/Shop/1', name: 'Demo Store', email: 'owner@demo.test', currencyCode: 'USD', primaryDomain: { url: 'https://demo.test', host: 'demo.test' } } } });
      }
      if (body.query.includes('ChatWithUssTheme')) {
        const content = '/* auto-generated */ {"current":{"color_schemes":{"scheme-1":{"settings":{"background":"#FFFFFF","button":"#E4572E"}}}}}';
        return json(200, { data: { themes: { nodes: [{ id: 'gid://shopify/OnlineStoreTheme/1', name: 'Dawn', files: { nodes: [{ body: { content } }] } }] } } });
      }
      return json(200, { data: {} });
    }

    if (u.pathname.startsWith('/api/') && u.pathname.endsWith('/graphql.json')) {
      if (!brand) return json(200, { data: { shop: { brand: null } } });
      return json(200, {
        data: {
          shop: {
            brand: {
              logo: { image: { url: 'https://cdn.shopify.com/s/files/logo.png' } },
              squareLogo: null,
              colors: { primary: [{ background: '#0a3d62', foreground: '#ffffff' }], secondary: [{ background: '#f39c12', foreground: '#000000' }] },
            },
          },
        },
      });
    }

    throw new Error(`Unexpected fetch in test: ${url}`);
  }

  return { fetchImpl, calls, state };
}
