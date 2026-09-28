import express from 'express';
import { publicWidgetConfig } from '../lib/settings.js';

/**
 * Storefront → Shopify App Proxy (https://{store}/apps/chatwithuss/*) → here (/proxy/*).
 * Signature/staleness/installation are enforced by verifyAppProxy before these run.
 * Order tracking, returns and AI chat endpoints join this router in Phases 3–5.
 */
export function proxyRouter() {
  const router = express.Router();
  router.use(express.json({ limit: '50kb' }));

  router.get('/', (req, res) => {
    res.set('Cache-Control', 'no-store').json({ ok: true, shop: req.shopDomain });
  });

  router.get('/config', (req, res) => {
    res.set('Cache-Control', 'private, max-age=60').json({
      ok: true,
      config: publicWidgetConfig(req.shop),
      customer: { logged_in: Boolean(req.customerId) },
    });
  });

  router.use((req, res) => res.status(404).json({ error: 'not_found' }));
  return router;
}
