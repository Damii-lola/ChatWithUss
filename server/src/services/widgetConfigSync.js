import crypto from 'node:crypto';
import { publicWidgetConfig } from '../lib/settings.js';

const INSTALLATION_QUERY = /* GraphQL */ `
  query ChatWithUssInstallation { currentAppInstallation { id } }
`;

const SET_METAFIELD = /* GraphQL */ `
  mutation ChatWithUssSetWidgetConfig($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id }
      userErrors { field message code }
    }
  }
`;

export const WIDGET_NAMESPACE = 'chatwithuss';
export const WIDGET_KEY = 'widget';

export const configHash = (cfg) => crypto.createHash('sha256').update(JSON.stringify(cfg)).digest('hex').slice(0, 16);

/**
 * Publishes the storefront widget config as an app-data metafield (owner = our AppInstallation).
 * The theme app extension reads it in Liquid (app.metafields.chatwithuss.widget), so the bubble
 * renders instantly with zero network calls, and it keeps working even if our server is asleep.
 * Only writes when the config actually changed (hash stored on the shop row).
 */
export function createWidgetConfigSync({ store, adminFor, logger }) {
  const installationIds = new Map();

  async function sync(shop, { force = false } = {}) {
    const cfg = publicWidgetConfig(shop);
    const hash = configHash(cfg);
    if (!force && shop.widget_config_hash === hash) return { changed: false };

    const admin = adminFor(shop.shop_domain);
    let ownerId = installationIds.get(shop.shop_domain);
    if (!ownerId) {
      const data = await admin.graphql(INSTALLATION_QUERY);
      ownerId = data?.currentAppInstallation?.id;
      if (!ownerId) throw new Error('currentAppInstallation id missing');
      installationIds.set(shop.shop_domain, ownerId);
    }

    const res = await admin.graphql(SET_METAFIELD, {
      metafields: [{ ownerId, namespace: WIDGET_NAMESPACE, key: WIDGET_KEY, type: 'json', value: JSON.stringify(cfg) }],
    });
    const errs = res?.metafieldsSet?.userErrors || [];
    if (errs.length) throw new Error(`metafieldsSet: ${errs.map((e) => e.message).join('; ')}`);

    await store.updateShop(shop.shop_domain, { widget_config_hash: hash });
    logger.info('widget.config_published', { shop: shop.shop_domain, hash });
    return { changed: true, hash };
  }

  /** Fire-and-forget variant for request paths that must not wait on Shopify. */
  function syncInBackground(shop) {
    sync(shop).catch((err) => logger.warn('widget.config_publish_failed', { shop: shop.shop_domain, err: err.message }));
  }

  return { sync, syncInBackground };
}
