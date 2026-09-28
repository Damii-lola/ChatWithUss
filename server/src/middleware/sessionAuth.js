import { verifySessionToken, SessionTokenError } from '../lib/shopify/verify.js';
import { ShopifyAuthError } from '../lib/shopify/auth.js';

const RETRY_HEADER = 'X-Shopify-Retry-Invalid-Session-Request';

/**
 * Guards /api/* for the embedded dashboard.
 *  1. Verifies the App Bridge session token (Authorization: Bearer <jwt>).
 *  2. Makes sure we hold working offline credentials — installs via token exchange if not.
 *  3. First install (or a shop we never finished syncing) → pulls shop info + brand.
 * On an invalid/expired token we answer 401 + X-Shopify-Retry-Invalid-Session-Request,
 * which tells App Bridge to fetch a fresh token and retry automatically.
 */
export function sessionAuth({ config, tokens, onboarding, store, logger }) {
  return async function requireSession(req, res, next) {
    const header = req.get('authorization') || '';
    const match = header.match(/^Bearer\s+(\S+)$/i);
    if (!match) {
      res.set(RETRY_HEADER, '1');
      return res.status(401).json({ error: 'unauthorized', message: 'Missing session token' });
    }
    const sessionToken = match[1];

    let shopDomain;
    try {
      ({ shop: shopDomain } = verifySessionToken(sessionToken, {
        apiKey: config.shopify.apiKey,
        apiSecret: config.shopify.apiSecret,
      }));
    } catch (err) {
      if (err instanceof SessionTokenError) {
        res.set(RETRY_HEADER, '1');
        return res.status(401).json({ error: 'unauthorized', message: err.message });
      }
      return next(err);
    }

    try {
      let { shop } = await tokens.ensureInstalled(shopDomain, sessionToken);

      if (!shop.shop_name) {
        try {
          ({ shop } = await onboarding.syncShop(shopDomain));
        } catch (err) {
          // Never block the dashboard on branding — defaults still work, sync retries next load.
          logger.warn('onboarding.sync_failed', { shop: shopDomain, err: err.message });
          shop = (await store.getShop(shopDomain)) || shop;
        }
      }

      req.shopDomain = shopDomain;
      req.shop = shop;
      req.sessionToken = sessionToken;
      return next();
    } catch (err) {
      if (err instanceof ShopifyAuthError) {
        logger.warn('auth.token_exchange_failed', { shop: shopDomain, status: err.status, code: err.code });
        if (err.reauth) {
          res.set(RETRY_HEADER, '1');
          return res.status(401).json({ error: 'unauthorized', message: 'Could not authenticate with Shopify' });
        }
        return res.status(502).json({ error: 'shopify_unavailable', message: 'Shopify is not responding. Try again in a moment.' });
      }
      return next(err);
    }
  };
}
