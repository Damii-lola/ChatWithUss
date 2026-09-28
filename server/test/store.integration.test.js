/**
 * Runs the real Supabase data layer against a live database.
 * Skipped unless STORE_TEST_URL + STORE_TEST_KEY are set, e.g. a throwaway Supabase project:
 *   STORE_TEST_URL=https://xyz.supabase.co STORE_TEST_KEY=<service_role> npm test
 * NEVER point this at production: it creates and deletes rows.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createSupabaseStore } from '../src/db/store.js';

const url = process.env.STORE_TEST_URL;
const key = process.env.STORE_TEST_KEY;
const skip = !url || !key ? 'STORE_TEST_URL / STORE_TEST_KEY not set' : false;

test('supabase store end to end', { skip }, async () => {
  const store = createSupabaseStore({ url, serviceRoleKey: key });
  const shop = `it-${crypto.randomUUID().slice(0, 8)}.myshopify.com`;

  assert.equal(await store.ping(), true);
  assert.equal(await store.getShop(shop), null);

  const created = await store.upsertShop(shop, { access_token_enc: 'v1.a.b.c', trial_ends_at: new Date().toISOString() });
  assert.equal(created.shop_domain, shop);
  const upserted = await store.upsertShop(shop, { scopes: 'read_orders' });
  assert.equal(upserted.id, created.id, 'upsert keeps the same row');
  assert.equal(upserted.access_token_enc, 'v1.a.b.c', 'upsert does not wipe untouched columns');

  const updated = await store.updateShop(shop, { settings: { greeting: 'Hi' }, shop_name: 'IT' });
  assert.equal(updated.settings.greeting, 'Hi');
  assert.ok(new Date(updated.updated_at) >= new Date(created.updated_at), 'updated_at trigger');
  assert.equal(await store.updateShop('missing-shop.myshopify.com', { shop_name: 'x' }), null);

  const wid = `wh-${crypto.randomUUID()}`;
  assert.equal(await store.claimWebhook(wid, shop, 'app/uninstalled'), true);
  assert.equal(await store.claimWebhook(wid, shop, 'app/uninstalled'), false);
  await store.releaseWebhook(wid);
  assert.equal(await store.claimWebhook(wid, shop, 'app/uninstalled'), true);

  // Seed customer data through the same client
  const { createClient } = await import('@supabase/supabase-js');
  const db = createClient(url, key, { auth: { persistSession: false } });
  const ins = async (table, rows) => {
    const { data, error } = await db.from(table).insert(rows).select('*');
    if (error) throw error;
    return data;
  };
  // bulk inserts need uniform keys (PostgREST nulls missing columns instead of applying defaults)
  const conv = (o) => ({ shop_id: created.id, customer_email: null, shopify_customer_id: null, order_id: null, needs_human: false, ...o });
  const [c1, c2, c3, c4] = await ins('conversations', [
    conv({ visitor_id: 'v1', customer_email: 'Jane_Doe@Example.com' }),
    conv({ visitor_id: 'v2', shopify_customer_id: 'gid://shopify/Customer/77' }),
    conv({ visitor_id: 'v3', order_id: '555' }),
    conv({ visitor_id: 'v4', customer_email: 'janeXdoe@example.com', needs_human: true }),
  ]);
  await ins('messages', [
    { conversation_id: c1.id, sender: 'customer', body: 'where is it' },
    { conversation_id: c4.id, sender: 'customer', body: 'keep' },
  ]);
  await ins('return_requests', [
    { shop_id: created.id, order_id: 'gid://shopify/Order/555', order_name: '#1001', customer_email: 'jane_doe@example.com', items: [], reason: 'Wrong size' },
  ]);
  await ins('resolution_events', [
    { shop_id: created.id, type: 'tracking_lookup' },
    { shop_id: created.id, type: 'tracking_lookup' },
    { shop_id: created.id, type: 'ai_answer' },
  ]);

  const criteria = { email: 'jane_doe@example.com', customerId: '77', orderIds: ['gid://shopify/Order/555'] };
  const found = await store.findCustomerData(created.id, criteria);
  assert.deepEqual(new Set(found.conversations.map((c) => c.id)), new Set([c1.id, c2.id, c3.id]), '"_" is literal, not a LIKE wildcard; case-insensitive; GID↔numeric');
  assert.equal(found.messages.length, 1);
  assert.equal(found.returns.length, 1);

  assert.deepEqual(await store.countResolutions(created.id, new Date(Date.now() - 86400000).toISOString()), { tracking_lookup: 2, ai_answer: 1 });
  assert.equal(await store.countOpenConversations(created.id), 1);
  assert.equal(await store.countPendingReturns(created.id), 1);

  await store.logCompliance({ shop_domain: shop, topic: 'customers/data_request', customer_email: 'Jane_Doe@example.com', payload: {}, result: { export: found } });
  const redacted = await store.redactCustomer(created.id, criteria);
  assert.deepEqual(redacted, { conversations: 3, messages: 1, returns: 1 });
  await store.scrubCompliance(shop, 'jane_doe@example.com');
  const { data: logs } = await db.from('compliance_requests').select('result').eq('shop_domain', shop);
  assert.deepEqual(logs[0].result, { scrubbed: true });

  const left = await store.findCustomerData(created.id, { email: 'janexdoe@example.com' });
  assert.equal(left.conversations.length, 1, 'unrelated customer untouched');

  assert.equal(await store.deleteShop(shop), 1);
  const { count } = await db.from('conversations').select('id', { count: 'exact', head: true }).eq('shop_id', created.id);
  assert.equal(count, 0, 'cascade delete');
  await db.from('compliance_requests').delete().eq('shop_domain', shop);
  await db.from('webhook_events').delete().eq('shop_domain', shop);
});
