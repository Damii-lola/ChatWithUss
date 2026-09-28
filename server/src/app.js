import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { createCipher } from './lib/crypto.js';
import { createShopifyAuth } from './lib/shopify/auth.js';
import { createTokenManager, ReauthRequiredError } from './lib/shopify/tokens.js';
import { createAdminClient, ShopifyApiError } from './lib/shopify/admin.js';
import { sanitizeShop, verifySessionToken } from './lib/shopify/verify.js';
import { createOnboarding } from './services/onboarding.js';
import { createWidgetConfigSync } from './services/widgetConfigSync.js';
import { sessionAuth } from './middleware/sessionAuth.js';
import { baseHeaders, embeddedFrameHeaders, verifyAppProxy } from './middleware/security.js';
import { webhooksRouter } from './routes/webhooks.js';
import { apiRouter } from './routes/api.js';
import { proxyRouter } from './routes/proxy.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

/**
 * Builds the Express app. Every external dependency is injectable
 * (store, fetch) so the whole thing runs under test without Shopify or Supabase.
 */
export function createApp({ config, store, logger, fetchImpl = globalThis.fetch }) {
  const cipher = createCipher(config.tokenEncryptionKey);
  const auth = createShopifyAuth({ apiKey: config.shopify.apiKey, apiSecret: config.shopify.apiSecret, fetchImpl });
  const tokens = createTokenManager({ store, cipher, auth, logger, trialDays: config.trialDays });
  const adminFor = (shop) => createAdminClient({ shop, tokens, apiVersion: config.shopify.apiVersion, fetchImpl, logger });
  const onboarding = createOnboarding({ store, adminFor, apiVersion: config.shopify.apiVersion, fetchImpl, logger });

  const widgetConfig = createWidgetConfigSync({ store, adminFor, logger });

  const shellHtml = renderShell(config);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Render terminates TLS in front of us
  app.use(baseHeaders);

  // ---------------------------------------------------------------- health
  app.get('/healthz', async (req, res) => {
    if (req.query.deep !== '1') return res.json({ ok: true });
    try {
      await store.ping();
      res.json({ ok: true, db: 'ok' });
    } catch (err) {
      logger.error('health.db_failed', { err: err.message });
      res.status(503).json({ ok: false, db: 'down' });
    }
  });

  // ---------------------------------------------------------------- webhooks (raw body — must precede any JSON parser)
  app.use('/webhooks', webhooksRouter({ config, store, logger }));

  // ---------------------------------------------------------------- storefront app proxy
  app.use('/proxy', verifyAppProxy({ config, store }), proxyRouter({ store, adminFor, logger }));

  // ---------------------------------------------------------------- embedded dashboard API
  app.use('/api', sessionAuth({ config, tokens, onboarding, store, logger }), apiRouter({ config, store, onboarding, adminFor, widgetConfig, logger }));

  // ---------------------------------------------------------------- static dashboard assets
  app.use('/assets', express.static(PUBLIC_DIR, { index: false, maxAge: config.isProd ? '1y' : 0, immutable: config.isProd }));

  // Legacy OAuth callback URLs (registered as redirect URLs) → bounce back into the embedded app.
  app.get(['/auth', '/auth/*path', '/api/auth/*path'], (req, res) => {
    const shop = sanitizeShop(req.query.shop);
    if (!shop) return res.status(400).type('text').send('Missing or invalid shop parameter.');
    return res.redirect(302, `https://${shop}/admin/apps/${config.shopify.apiKey}`);
  });

  // ---------------------------------------------------------------- embedded dashboard shell
  app.get(['/', '/settings'], embeddedFrameHeaders, (req, res) => {
    // Admin loads us with ?id_token=… — warm up the install so the first /api call is instant.
    const idToken = typeof req.query.id_token === 'string' ? req.query.id_token : null;
    if (idToken) {
      try {
        const { shop } = verifySessionToken(idToken, { apiKey: config.shopify.apiKey, apiSecret: config.shopify.apiSecret });
        tokens
          .ensureInstalled(shop, idToken)
          .then(async ({ shop: row }) => {
            if (!row.shop_name) await onboarding.syncShop(shop);
          })
          .catch((err) => logger.warn('shell.prewarm_failed', { shop, err: err.message }));
      } catch {
        /* invalid/expired id_token in URL — the dashboard fetches a fresh one via App Bridge */
      }
    }
    res.set('Cache-Control', 'no-store').type('html').send(shellHtml);
  });

  // ---------------------------------------------------------------- errors
  app.use((req, res) => res.status(404).type('text').send('Not found'));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err instanceof ReauthRequiredError) {
      res.set('X-Shopify-Retry-Invalid-Session-Request', '1');
      return res.status(401).json({ error: 'reauth_required' });
    }
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json' });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'payload_too_large' });
    const status = err instanceof ShopifyApiError ? 502 : 500;
    logger.error('request.failed', { method: req.method, path: req.path, shop: req.shopDomain, err });
    if (res.headersSent) return;
    res.status(status).json({ error: status === 502 ? 'shopify_error' : 'internal_error', message: 'Something went wrong. Please try again.' });
  });

  return { app, tokens, adminFor, onboarding, widgetConfig };
}

/** index.html with the API key + cache-busted asset URLs baked in once at boot. */
function renderShell(config) {
  const template = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const version = (file) =>
    crypto.createHash('sha256').update(fs.readFileSync(path.join(PUBLIC_DIR, file))).digest('hex').slice(0, 10);
  return template
    .replaceAll('{{SHOPIFY_API_KEY}}', escapeAttr(config.shopify.apiKey))
    .replaceAll('{{CSS_VERSION}}', version('app.css'))
    .replaceAll('{{JS_VERSION}}', version('app.js'));
}

function escapeAttr(s) {
  return String(s).replace(/[&"<>]/g, (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[c]);
}
