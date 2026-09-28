import express from 'express';
import { withDefaults, validateSettingsPatch, ValidationError, publicWidgetConfig, LIVE_FEATURES } from '../lib/settings.js';
import { getEmbedStatus } from '../services/widgetStatus.js';

/** Minutes a human agent spends on a typical repetitive ticket (WISMO, returns, FAQ). */
export const MINUTES_PER_TICKET = 4;

const RESOLUTION_TYPES = ['tracking_lookup', 'return_request', 'ai_answer', 'agent_reply', 'order_cancel', 'refund', 'address_update'];
// Tickets that would have landed on a human if the widget didn't exist
const DEFLECTED = new Set(['tracking_lookup', 'return_request', 'ai_answer']);

/** Everything under /api — already authenticated by sessionAuth. */
export function apiRouter({ config, store, onboarding, adminFor, widgetConfig, logger }) {
  const router = express.Router();
  router.use(express.json({ limit: '100kb' }));

  const shopView = (shop) => ({
    domain: shop.shop_domain,
    name: shop.shop_name || shop.shop_domain.replace('.myshopify.com', ''),
    email: shop.email || null,
    currency: shop.currency || null,
    primary_domain: shop.primary_domain || null,
    plan: shop.plan,
    billing_status: shop.billing_status,
    trial_ends_at: shop.trial_ends_at || null,
    installed_at: shop.installed_at,
    brand_synced_at: shop.brand_synced_at || null,
    widget_seen_at: shop.widget_seen_at || null,
  });

  router.get('/me', (req, res) => {
    const shop = req.shop;
    // Keeps the storefront metafield in sync (first run after install / after we ship new features).
    widgetConfig.syncInBackground(shop);
    res.json({
      shop: shopView(shop),
      settings: withDefaults(shop.settings),
      widget_preview: publicWidgetConfig(shop),
      live_features: LIVE_FEATURES,
      app: {
        api_key: config.shopify.apiKey,
        theme_editor_url: `https://${shop.shop_domain}/admin/themes/current/editor?context=apps&activateAppId=${config.shopify.apiKey}/${config.shopify.widgetHandle}`,
        storefront_url: `https://${shop.primary_domain || shop.shop_domain}`,
      },
    });
  });

  router.get('/stats', async (req, res, next) => {
    try {
      const days = clampInt(req.query.days, 1, 365, 30);
      const since = new Date(Date.now() - days * 86400000).toISOString();
      const [counts, openConversations, pendingReturns] = await Promise.all([
        store.countResolutions(req.shop.id, since),
        store.countOpenConversations(req.shop.id),
        store.countPendingReturns(req.shop.id),
      ]);

      const byType = Object.fromEntries(RESOLUTION_TYPES.map((t) => [t, counts[t] || 0]));
      const total = Object.values(byType).reduce((a, b) => a + b, 0);
      const deflected = RESOLUTION_TYPES.filter((t) => DEFLECTED.has(t)).reduce((a, t) => a + byType[t], 0);
      const minutesSaved = deflected * MINUTES_PER_TICKET;

      res.json({
        days,
        total,
        deflected,
        by_type: byType,
        minutes_saved: minutesSaved,
        hours_saved: Math.round((minutesSaved / 60) * 10) / 10,
        minutes_per_ticket: MINUTES_PER_TICKET,
        open_conversations: openConversations,
        pending_returns: pendingReturns,
      });
    } catch (err) {
      next(err);
    }
  });

  /** Setup-guide check: is the app embed on in the live theme, and has a storefront loaded it? */
  router.get('/widget-status', async (req, res) => {
    let embed = { theme: null, enabled: null };
    try {
      embed = await getEmbedStatus(adminFor(req.shopDomain), config.shopify.widgetHandle);
    } catch (err) {
      logger.warn('widget_status.failed', { shop: req.shopDomain, err: err.message });
    }
    const fresh = await store.getShop(req.shopDomain);
    const seenAt = fresh?.widget_seen_at || null;
    res.json({
      theme: embed.theme,
      embed_enabled: embed.enabled,
      seen_at: seenAt,
      live: embed.enabled === true || (embed.enabled === null && Boolean(seenAt)),
    });
  });

  router.put('/settings', async (req, res, next) => {
    try {
      const patch = validateSettingsPatch(req.body);
      const settings = { ...withDefaults(req.shop.settings), ...patch, settings_saved_at: new Date().toISOString() };
      const updated = await store.updateShop(req.shopDomain, { settings });
      logger.info('settings.updated', { shop: req.shopDomain, keys: Object.keys(patch) });
      const published = await publishNow(updated);
      res.json({ settings: withDefaults(updated.settings), widget_preview: publicWidgetConfig(updated), published });
    } catch (err) {
      if (err instanceof ValidationError) return res.status(422).json({ error: 'validation_failed', errors: err.errors });
      next(err);
    }
  });

  router.post('/brand/sync', async (req, res, next) => {
    try {
      const { shop, brandFound } = await onboarding.syncShop(req.shopDomain, { resetBrand: true });
      await publishNow(shop);
      res.json({
        brand_found: brandFound,
        shop: shopView(shop),
        settings: withDefaults(shop.settings),
        widget_preview: publicWidgetConfig(shop),
      });
    } catch (err) {
      next(err);
    }
  });

  /** Push to the storefront right away so "Save" is instantly visible; never fail the save over it. */
  async function publishNow(shop) {
    try {
      await widgetConfig.sync(shop);
      return true;
    } catch (err) {
      logger.warn('widget.config_publish_failed', { shop: shop.shop_domain, err: err.message });
      return false;
    }
  }

  router.use((req, res) => res.status(404).json({ error: 'not_found' }));
  return router;
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
