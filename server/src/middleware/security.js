import { sanitizeShop, verifyProxySignature } from '../lib/shopify/verify.js';

/** Baseline headers for every response. */
export function baseHeaders(req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.removeHeader('X-Powered-By');
  next();
}

/**
 * Embedded pages must only be framable by the merchant's own admin.
 * Shopify app review checks for exactly this frame-ancestors policy.
 */
export function embeddedFrameHeaders(req, res, next) {
  const shop = sanitizeShop(req.query.shop);
  const ancestors = shop
    ? `https://${shop} https://admin.shopify.com`
    : 'https://*.myshopify.com https://admin.shopify.com';
  res.set('Content-Security-Policy', `frame-ancestors ${ancestors};`);
  next();
}

/**
 * App Proxy guard: Shopify signs every storefront → /apps/chatwithuss/* request.
 * Rejects anything unsigned, stale (>5 min) or for a shop that isn't installed.
 */
export function verifyAppProxy({ config, store, maxAgeSeconds = 300, clock = Date.now }) {
  return async function appProxyGuard(req, res, next) {
    const rawQuery = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?') + 1) : '';
    if (!verifyProxySignature(rawQuery, config.shopify.apiSecret)) {
      return res.status(401).json({ error: 'invalid_signature' });
    }

    const ts = Number(req.query.timestamp);
    if (!Number.isFinite(ts) || Math.abs(clock() / 1000 - ts) > maxAgeSeconds) {
      return res.status(401).json({ error: 'stale_request' });
    }

    const shopDomain = sanitizeShop(req.query.shop);
    if (!shopDomain) return res.status(400).json({ error: 'invalid_shop' });

    try {
      const shop = await store.getShop(shopDomain);
      if (!shop || shop.uninstalled_at) return res.status(404).json({ error: 'shop_not_installed' });
      req.shopDomain = shopDomain;
      req.shop = shop;
      req.customerId = req.query.logged_in_customer_id ? String(req.query.logged_in_customer_id) : null;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}
