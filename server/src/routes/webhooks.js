import express from 'express';
import { verifyWebhookHmac, sanitizeShop } from '../lib/shopify/verify.js';

/**
 * One endpoint for every topic (Shopify sends X-Shopify-Topic).
 * Also answers the legacy per-topic paths (/webhooks/app/uninstalled, /webhooks/compliance, …)
 * so any subscription created from older config keeps working.
 *
 * Contract with Shopify:
 *  - invalid HMAC → 401 (required by app review)
 *  - duplicate delivery (same X-Shopify-Webhook-Id) → 200, no reprocessing
 *  - handler failure → claim released + 500, so Shopify retries
 */
export function webhooksRouter({ config, store, logger }) {
  const router = express.Router();

  const handlers = {
    'app/uninstalled': async (shop) => {
      await store.updateShop(shop, {
        uninstalled_at: new Date().toISOString(),
        access_token_enc: null,
        access_token_expires_at: null,
        refresh_token_enc: null,
        refresh_token_expires_at: null,
        billing_status: 'cancelled',
        subscription_id: null,
      });
      return { action: 'marked_uninstalled' };
    },

    'app/scopes_update': async (shop, payload) => {
      const current = Array.isArray(payload?.current) ? payload.current.join(',') : null;
      if (current !== null) await store.updateShop(shop, { scopes: current });
      return { scopes: current };
    },

    'customers/data_request': async (shop, payload) => {
      const row = await store.getShop(shop);
      const criteria = customerCriteria(payload, 'orders_requested');
      const data = row ? await store.findCustomerData(row.id, criteria) : { conversations: [], messages: [], returns: [] };
      await store.logCompliance({
        shop_domain: shop,
        topic: 'customers/data_request',
        customer_email: criteria.email,
        shopify_customer_id: criteria.customerId,
        payload,
        result: {
          counts: { conversations: data.conversations.length, messages: data.messages.length, returns: data.returns.length },
          export: data,
        },
      });
      return { conversations: data.conversations.length, returns: data.returns.length };
    },

    'customers/redact': async (shop, payload) => {
      const row = await store.getShop(shop);
      const criteria = customerCriteria(payload, 'orders_to_redact');
      const counts = row ? await store.redactCustomer(row.id, criteria) : { conversations: 0, messages: 0, returns: 0 };
      if (criteria.email) await store.scrubCompliance(shop, criteria.email);
      await store.logCompliance({
        shop_domain: shop,
        topic: 'customers/redact',
        customer_email: null, // don't keep what we were asked to erase
        shopify_customer_id: criteria.customerId,
        payload: { shop_id: payload?.shop_id, shop_domain: payload?.shop_domain, customer: { id: payload?.customer?.id ?? null }, orders_to_redact: payload?.orders_to_redact ?? [] },
        result: { deleted: counts },
      });
      return counts;
    },

    'shop/redact': async (shop, payload) => {
      const deleted = await store.deleteShop(shop); // cascades conversations, messages, returns, knowledge, stats
      await store.scrubCompliance(shop);
      await store.logCompliance({
        shop_domain: shop,
        topic: 'shop/redact',
        payload: { shop_id: payload?.shop_id ?? null, shop_domain: payload?.shop_domain ?? shop },
        result: { shop_rows_deleted: deleted },
      });
      return { shop_rows_deleted: deleted };
    },
  };

  const raw = express.raw({ type: () => true, limit: '5mb' });

  router.post(['/', '/*path'], raw, async (req, res) => {
    const hmac = req.get('x-shopify-hmac-sha256');
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

    if (!verifyWebhookHmac(rawBody, hmac, config.shopify.apiSecret)) {
      logger.warn('webhook.invalid_hmac', { path: req.originalUrl });
      return res.status(401).send('Invalid HMAC');
    }

    const topic = (req.get('x-shopify-topic') || '').toLowerCase();
    const shop = sanitizeShop(req.get('x-shopify-shop-domain'));
    const webhookId = req.get('x-shopify-webhook-id') || req.get('x-shopify-event-id') || null;

    let payload = {};
    try {
      payload = rawBody.length ? JSON.parse(rawBody.toString('utf8')) : {};
    } catch {
      return res.status(400).send('Invalid JSON');
    }

    const handler = handlers[topic];
    if (!shop || !handler) {
      logger.warn('webhook.unhandled', { topic, shop: req.get('x-shopify-shop-domain') });
      return res.status(200).send('OK'); // acknowledge so Shopify doesn't retry forever
    }

    let claimed = false;
    try {
      if (webhookId) {
        claimed = await store.claimWebhook(webhookId, shop, topic);
        if (!claimed) {
          logger.info('webhook.duplicate', { topic, shop, webhookId });
          return res.status(200).send('OK');
        }
      }
      const result = await handler(shop, payload);
      logger.info('webhook.processed', { topic, shop, webhookId, result });
      return res.status(200).send('OK');
    } catch (err) {
      logger.error('webhook.failed', { topic, shop, webhookId, err });
      if (claimed) await store.releaseWebhook(webhookId).catch(() => {});
      return res.status(500).send('Processing failed');
    }
  });

  return router;
}

function customerCriteria(payload, ordersKey) {
  const c = payload?.customer || {};
  return {
    email: typeof c.email === 'string' && c.email.trim() ? c.email.trim() : null,
    customerId: c.id != null ? String(c.id) : null,
    orderIds: Array.isArray(payload?.[ordersKey]) ? payload[ordersKey].map(String) : [],
  };
}
