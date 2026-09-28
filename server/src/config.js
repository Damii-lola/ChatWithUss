const REQUIRED = [
  'APP_URL',
  'SHOPIFY_API_KEY',
  'SHOPIFY_API_SECRET',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'TOKEN_ENCRYPTION_KEY',
];

export const SHOPIFY_API_VERSION = '2026-07';

export const SCOPES = [
  'read_orders',
  'write_orders',
  'read_customers',
  'read_products',
  'read_fulfillments',
  'read_merchant_managed_fulfillment_orders',
  'read_returns',
  'write_returns',
  'read_legal_policies',
  'read_online_store_pages',
  'read_content',
  'read_themes',
];

/**
 * Build config from an env object. Throws with every missing key listed at once,
 * so a misconfigured Render deploy fails loudly on boot instead of at first request.
 */
export function loadConfig(env = process.env) {
  const missing = REQUIRED.filter((k) => !env[k] || !String(env[k]).trim());
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  const appUrl = String(env.APP_URL).trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(appUrl)) {
    throw new Error('APP_URL must start with https://');
  }

  return Object.freeze({
    appUrl,
    port: Number(env.PORT) || 3000,
    isProd: env.NODE_ENV === 'production',
    logLevel: env.LOG_LEVEL || 'info',
    shopify: Object.freeze({
      apiKey: env.SHOPIFY_API_KEY.trim(),
      apiSecret: env.SHOPIFY_API_SECRET.trim(),
      apiVersion: SHOPIFY_API_VERSION,
      scopes: SCOPES,
      widgetHandle: 'chat-widget',
    }),
    supabase: Object.freeze({
      url: env.SUPABASE_URL.trim(),
      serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY.trim(),
    }),
    tokenEncryptionKey: env.TOKEN_ENCRYPTION_KEY,
    mistralApiKey: env.MISTRAL_API_KEY || null,
    trialDays: 14,
  });
}
