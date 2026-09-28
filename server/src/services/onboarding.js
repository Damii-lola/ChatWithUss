import { withDefaults, normalizeHex } from '../lib/settings.js';

const SHOP_QUERY = /* GraphQL */ `
  query ChatWithUssShop {
    shop {
      id
      name
      email
      currencyCode
      primaryDomain { url host }
    }
  }
`;

// Storefront API (tokenless) — Shop.brand is only exposed here, not on the Admin API.
const BRAND_QUERY = /* GraphQL */ `
  query ChatWithUssBrand {
    shop {
      brand {
        logo { image { url } }
        squareLogo { image { url } }
        colors {
          primary { background foreground }
          secondary { background foreground }
        }
      }
    }
  }
`;

const THEME_QUERY = /* GraphQL */ `
  query ChatWithUssTheme {
    themes(first: 1, roles: [MAIN]) {
      nodes {
        id
        name
        files(filenames: ["config/settings_data.json"], first: 1) {
          nodes {
            body {
              ... on OnlineStoreThemeFileBodyText { content }
            }
          }
        }
      }
    }
  }
`;

/**
 * Pulls shop identity + branding into our DB so the widget matches the store on first open,
 * with zero configuration. Brand sources, best first:
 *   1. Storefront API Shop.brand (what the merchant set in Settings → Brand)
 *   2. Main theme's settings_data.json (button/accent colour)
 *   3. Our defaults
 */
export function createOnboarding({ store, adminFor, apiVersion, fetchImpl = globalThis.fetch, logger }) {
  async function fetchStorefrontBrand(shopDomain) {
    try {
      const res = await fetchImpl(`https://${shopDomain}/api/${apiVersion}/graphql.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query: BRAND_QUERY }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return null;
      const body = await res.json().catch(() => null);
      const brand = body?.data?.shop?.brand;
      if (!brand) return null;
      const first = (v) => (Array.isArray(v) ? v[0] : v) || null;
      const primary = first(brand.colors?.primary);
      const secondary = first(brand.colors?.secondary);
      return {
        logo_url: brand.logo?.image?.url || brand.squareLogo?.image?.url || null,
        brand_color: normalizeHex(primary?.background),
        accent_color: normalizeHex(secondary?.background) || normalizeHex(primary?.background),
      };
    } catch (err) {
      logger.debug('onboarding.storefront_brand_failed', { shop: shopDomain, err: err.message });
      return null;
    }
  }

  async function fetchThemeColors(admin) {
    try {
      const data = await admin.graphql(THEME_QUERY);
      const content = data?.themes?.nodes?.[0]?.files?.nodes?.[0]?.body?.content;
      return content ? extractThemeColors(content) : null;
    } catch (err) {
      logger.debug('onboarding.theme_colors_failed', { shop: admin.shop, err: err.message });
      return null;
    }
  }

  /**
   * @param {object} opts
   * @param {boolean} opts.resetBrand - merchant clicked "Re-sync from store": overwrite custom colours
   */
  async function syncShop(shopDomain, { resetBrand = false } = {}) {
    const admin = adminFor(shopDomain);
    const data = await admin.graphql(SHOP_QUERY);
    const s = data?.shop || {};

    const row = await store.getShop(shopDomain);
    const settings = withDefaults(row?.settings);
    const applyBrand = resetBrand || settings.brand_source !== 'custom';

    const patch = {
      shop_name: s.name || row?.shop_name || null,
      email: s.email || row?.email || null,
      currency: s.currencyCode || row?.currency || null,
      primary_domain: s.primaryDomain?.host || row?.primary_domain || null,
      shopify_shop_id: s.id || row?.shopify_shop_id || null,
    };

    let brandFound = false;
    if (applyBrand) {
      const brand = (await fetchStorefrontBrand(shopDomain)) || {};
      if (!brand.brand_color) {
        const theme = await fetchThemeColors(admin);
        if (theme) {
          brand.brand_color = brand.brand_color || theme.brand_color;
          brand.accent_color = brand.accent_color || theme.accent_color;
        }
      }
      brandFound = Boolean(brand.brand_color || brand.logo_url);
      patch.settings = {
        ...settings,
        brand_color: brand.brand_color || (resetBrand ? '#111111' : settings.brand_color),
        accent_color: brand.accent_color || brand.brand_color || (resetBrand ? '#4F46E5' : settings.accent_color),
        logo_url: brand.logo_url ?? (resetBrand ? null : settings.logo_url),
        brand_source: 'auto',
      };
      patch.brand_synced_at = new Date().toISOString();
    }

    const updated = await store.updateShop(shopDomain, patch);
    logger.info('onboarding.synced', { shop: shopDomain, brandApplied: applyBrand, brandFound });
    return { shop: updated, brandFound };
  }

  return { syncShop };
}

// ---------------------------------------------------------------- theme parsing

const HEX_ANY = /^#?(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Parses settings_data.json (which may start with a /* comment *\/) and finds the brand colour. */
export function extractThemeColors(raw) {
  let json;
  try {
    json = JSON.parse(String(raw).replace(/^﻿/, '').replace(/^\s*\/\*[\s\S]*?\*\/\s*/, ''));
  } catch {
    return null;
  }
  let current = json.current;
  if (typeof current === 'string') current = json.presets?.[current];
  if (!current || typeof current !== 'object') return null;

  // Dawn 10+ / modern themes: color_schemes → first scheme's button colour
  const schemes = current.color_schemes;
  if (schemes && typeof schemes === 'object') {
    for (const scheme of Object.values(schemes)) {
      const st = scheme?.settings || {};
      const button = normalizeHex(st.button) || normalizeHex(st.primary_button_background);
      if (button && !isNearWhite(button)) return { brand_color: button, accent_color: button };
    }
  }

  // Older themes: flat keys
  const preferred = ['colors_accent_1', 'color_button', 'colors_button', 'color_primary', 'accent_color', 'color_accent', 'colors_accent', 'button_color'];
  for (const key of preferred) {
    const hex = normalizeHex(current[key]);
    if (hex && !isNearWhite(hex)) return { brand_color: hex, accent_color: hex };
  }

  // Last resort: any key that smells like a button/accent/primary colour
  for (const [key, value] of Object.entries(current)) {
    if (/(button|accent|primary)/i.test(key) && typeof value === 'string' && HEX_ANY.test(value)) {
      const hex = normalizeHex(value);
      if (hex && !isNearWhite(hex)) return { brand_color: hex, accent_color: hex };
    }
  }
  return null;
}

function isNearWhite(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return r > 240 && g > 240 && b > 240;
}
