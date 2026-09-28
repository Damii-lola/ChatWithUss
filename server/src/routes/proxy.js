import express from 'express';
import { publicWidgetConfig } from '../lib/settings.js';
import { createRateLimiter } from '../lib/rateLimit.js';
import { ReauthRequiredError } from '../lib/shopify/tokens.js';
import {
  findOrder,
  listCustomerOrders,
  orderView,
  orderSummary,
  normalizeOrderNumber,
  normalizeEmail,
  TrackingSetupError,
} from '../services/tracking.js';

const NOT_FOUND = {
  ok: false,
  error: 'not_found',
  message: "We couldn't find an order with that number and email. Check your order confirmation email and try again.",
};
const UNAVAILABLE = {
  ok: false,
  error: 'unavailable',
  message: "Order tracking isn't available right now. Please try again in a few minutes.",
};

/**
 * Storefront → Shopify App Proxy (https://{store}/apps/chatwithuss/*) → here (/proxy/*).
 * Signature, freshness and installation are enforced by verifyAppProxy before these run.
 */
export function proxyRouter({ store, adminFor, logger, clock = Date.now }) {
  const router = express.Router();
  router.use(express.json({ limit: '20kb' }));

  // Anti-enumeration: per-visitor, per-order-number and per-shop ceilings.
  const perVisitor = createRateLimiter({ limit: 20, windowMs: 10 * 60 * 1000, clock });
  const perOrderFailures = createRateLimiter({ limit: 6, windowMs: 15 * 60 * 1000, clock });
  const perShop = createRateLimiter({ limit: 600, windowMs: 10 * 60 * 1000, clock });
  const seenThrottle = new Map();

  const visitorKey = (req) => {
    const fwd = (req.get('x-forwarded-for') || '').split(',')[0].trim();
    return `${req.shopDomain}|${fwd || req.ip || 'anon'}`;
  };

  const tooMany = (res, retryAfter) =>
    res
      .status(429)
      .set('Retry-After', String(retryAfter))
      .json({ ok: false, error: 'rate_limited', message: 'Too many attempts. Please wait a few minutes and try again.' });

  function noteWidgetSeen(shop) {
    const last = seenThrottle.get(shop.shop_domain) || 0;
    if (clock() - last < 10 * 60 * 1000) return;
    seenThrottle.set(shop.shop_domain, clock());
    store.updateShop(shop.shop_domain, { widget_seen_at: new Date(clock()).toISOString() }).catch(() => {});
  }

  router.get('/', (req, res) => {
    res.set('Cache-Control', 'no-store').json({ ok: true, shop: req.shopDomain });
  });

  router.get('/config', (req, res) => {
    noteWidgetSeen(req.shop);
    res.set('Cache-Control', 'private, max-age=60').json({
      ok: true,
      config: publicWidgetConfig(req.shop),
      customer: { logged_in: Boolean(req.customerId) },
    });
  });

  /** Logged-in shoppers: their 5 most recent orders (identity comes from Shopify's signature). */
  router.get('/orders', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!req.customerId) return res.status(401).json({ ok: false, error: 'not_logged_in' });
    const v = perVisitor.hit(visitorKey(req));
    if (!v.ok) return tooMany(res, v.retryAfter);
    try {
      const orders = await listCustomerOrders(adminFor(req.shopDomain), req.customerId, 5);
      res.json({ ok: true, orders: orders.map(orderSummary) });
    } catch (err) {
      logFailure(logger, req, 'proxy.orders_failed', err);
      res.status(503).json(UNAVAILABLE);
    }
  });

  /** Guest (order number + email) or logged-in (order number only) tracking lookup. */
  router.post('/track', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const orderNumber = normalizeOrderNumber(req.body?.order);
    const email = req.body?.email ? normalizeEmail(req.body.email) : null;

    const errors = {};
    if (!orderNumber) errors.order = 'Enter your order number, e.g. #1001';
    if (!req.customerId && !email) errors.email = 'Enter the email you used at checkout';
    if (req.body?.email && !email) errors.email = 'That email doesn’t look right';
    if (Object.keys(errors).length) return res.status(422).json({ ok: false, error: 'validation_failed', errors });

    const shopGate = perShop.hit(req.shopDomain);
    if (!shopGate.ok) return tooMany(res, shopGate.retryAfter);
    const v = perVisitor.hit(visitorKey(req));
    if (!v.ok) return tooMany(res, v.retryAfter);
    const failKey = `${req.shopDomain}|${orderNumber}`;
    if (perOrderFailures.peek(failKey) >= 6) return tooMany(res, 15 * 60);

    try {
      const order = await findOrder(adminFor(req.shopDomain), { orderNumber, email, customerId: req.customerId });
      if (!order) {
        perOrderFailures.hit(failKey);
        return res.status(404).json(NOT_FOUND);
      }
      perOrderFailures.reset(failKey);
      store.recordResolution(req.shop.id, 'tracking_lookup').catch((err) => logger.warn('stats.record_failed', { shop: req.shopDomain, err: err.message }));
      logger.info('proxy.tracking_lookup', { shop: req.shopDomain, loggedIn: Boolean(req.customerId) });
      return res.json({ ok: true, order: orderView(order) });
    } catch (err) {
      logFailure(logger, req, 'proxy.track_failed', err);
      return res.status(503).json(UNAVAILABLE);
    }
  });

  router.use((req, res) => res.status(404).json({ ok: false, error: 'not_found' }));
  return router;
}

function logFailure(logger, req, event, err) {
  const level = err instanceof TrackingSetupError || err instanceof ReauthRequiredError ? 'error' : 'warn';
  logger[level](event, {
    shop: req.shopDomain,
    reason: err instanceof TrackingSetupError ? 'protected_customer_data_not_approved' : err instanceof ReauthRequiredError ? 'reauth_required' : 'shopify_error',
    err: err.message,
  });
}
