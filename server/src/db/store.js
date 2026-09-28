import { createClient } from '@supabase/supabase-js';

/**
 * Data-access layer. Every DB call in the app goes through this object,
 * so routes never touch Supabase directly (and tests swap in a memory store
 * with the identical interface: test/helpers/memoryStore.js).
 */

class StoreError extends Error {
  constructor(op, error) {
    super(`DB ${op} failed: ${error?.message || error}`);
    this.name = 'StoreError';
    this.cause = error;
  }
}

const check = (op, { data, error }) => {
  if (error) throw new StoreError(op, error);
  return data;
};

/** Accepts numeric ids and gid://shopify/X/123 → returns both spellings for matching. */
export function idVariants(ids, resource) {
  const out = new Set();
  for (const raw of ids || []) {
    if (raw === null || raw === undefined || raw === '') continue;
    const s = String(raw);
    const num = s.match(/(\d+)$/)?.[1];
    out.add(s);
    if (num) {
      out.add(num);
      out.add(`gid://shopify/${resource}/${num}`);
    }
  }
  return [...out];
}

export function createSupabaseStore({ url, serviceRoleKey }) {
  const db = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { 'x-application-name': 'chatwithuss-server' } },
  });

  const store = {
    async ping() {
      check('ping', await db.from('shops').select('id', { head: true, count: 'exact' }).limit(1));
      return true;
    },

    // ------------------------------------------------------------ shops
    async getShop(shopDomain) {
      return check('getShop', await db.from('shops').select('*').eq('shop_domain', shopDomain).maybeSingle());
    },

    async upsertShop(shopDomain, fields) {
      return check(
        'upsertShop',
        await db.from('shops').upsert({ shop_domain: shopDomain, ...fields }, { onConflict: 'shop_domain' }).select('*').single(),
      );
    },

    async updateShop(shopDomain, fields) {
      return check('updateShop', await db.from('shops').update(fields).eq('shop_domain', shopDomain).select('*').maybeSingle());
    },

    async deleteShop(shopDomain) {
      const rows = check('deleteShop', await db.from('shops').delete().eq('shop_domain', shopDomain).select('id'));
      return rows?.length || 0;
    },

    // ------------------------------------------------------------ webhooks
    /** Returns true if this webhook id is new (we should process it), false if already seen. */
    async claimWebhook(webhookId, shopDomain, topic) {
      const { error } = await db.from('webhook_events').insert({ webhook_id: webhookId, shop_domain: shopDomain, topic });
      if (!error) return true;
      if (error.code === '23505') return false; // unique_violation → duplicate delivery
      throw new StoreError('claimWebhook', error);
    },

    /** Processing failed → forget the claim so Shopify's retry gets processed. */
    async releaseWebhook(webhookId) {
      check('releaseWebhook', await db.from('webhook_events').delete().eq('webhook_id', webhookId));
    },

    // ------------------------------------------------------------ compliance
    async logCompliance(record) {
      check('logCompliance', await db.from('compliance_requests').insert(record));
    },

    /** Wipe stored export payloads (after the customer or shop is redacted). */
    async scrubCompliance(shopDomain, email = null) {
      let q = db.from('compliance_requests').update({ result: { scrubbed: true } }).eq('shop_domain', shopDomain).eq('topic', 'customers/data_request');
      if (email) q = q.ilike('customer_email', String(email).trim().replace(/[\\%_]/g, (m) => `\\${m}`));
      check('scrubCompliance', await q);
    },

    async findCustomerData(shopId, { email, customerId, orderIds }) {
      const orders = idVariants(orderIds, 'Order');
      const customers = idVariants(customerId ? [customerId] : [], 'Customer');
      const filters = [];
      if (email) filters.push(`customer_email.ilike.${escapeIlike(email)}`);
      if (customers.length) filters.push(`shopify_customer_id.in.(${customers.map(quote).join(',')})`);
      if (orders.length) filters.push(`order_id.in.(${orders.map(quote).join(',')})`);
      if (!filters.length) return { conversations: [], messages: [], returns: [] };

      const conversations = check(
        'findCustomerData.conversations',
        await db.from('conversations').select('*').eq('shop_id', shopId).or(filters.join(',')),
      ) || [];

      const convIds = conversations.map((c) => c.id);
      const messages = convIds.length
        ? check('findCustomerData.messages', await db.from('messages').select('*').in('conversation_id', convIds).order('created_at')) || []
        : [];

      const returnFilters = [];
      if (email) returnFilters.push(`customer_email.ilike.${escapeIlike(email)}`);
      if (orders.length) returnFilters.push(`order_id.in.(${orders.map(quote).join(',')})`);
      const returns = returnFilters.length
        ? check('findCustomerData.returns', await db.from('return_requests').select('*').eq('shop_id', shopId).or(returnFilters.join(','))) || []
        : [];

      return { conversations, messages, returns };
    },

    async redactCustomer(shopId, criteria) {
      const found = await store.findCustomerData(shopId, criteria);
      const convIds = found.conversations.map((c) => c.id);
      const returnIds = found.returns.map((r) => r.id);
      if (returnIds.length) check('redact.returns', await db.from('return_requests').delete().in('id', returnIds));
      if (convIds.length) check('redact.conversations', await db.from('conversations').delete().in('id', convIds)); // messages cascade
      return { conversations: convIds.length, messages: found.messages.length, returns: returnIds.length };
    },

    // ------------------------------------------------------------ stats
    async countResolutions(shopId, sinceIso) {
      const rows = check(
        'countResolutions',
        await db.from('resolution_events').select('type').eq('shop_id', shopId).gte('created_at', sinceIso).limit(100000),
      ) || [];
      const counts = {};
      for (const { type } of rows) counts[type] = (counts[type] || 0) + 1;
      return counts;
    },

    async countOpenConversations(shopId) {
      const { count, error } = await db
        .from('conversations')
        .select('id', { count: 'exact', head: true })
        .eq('shop_id', shopId)
        .eq('needs_human', true)
        .neq('status', 'resolved');
      if (error) throw new StoreError('countOpenConversations', error);
      return count || 0;
    },

    async countPendingReturns(shopId) {
      const { count, error } = await db
        .from('return_requests')
        .select('id', { count: 'exact', head: true })
        .eq('shop_id', shopId)
        .eq('status', 'pending');
      if (error) throw new StoreError('countPendingReturns', error);
      return count || 0;
    },
  };

  return store;
}

// PostgREST filter-value quoting for .or() strings
function quote(v) {
  return `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
function escapeIlike(email) {
  // exact, case-insensitive match: escape LIKE wildcards, then quote for PostgREST
  return quote(String(email).trim().replace(/[\\%_]/g, (m) => `\\${m}`));
}
