import { ShopifyAuthError } from './auth.js';

export class ReauthRequiredError extends Error {
  constructor(shop, reason) {
    super(`Shop ${shop} needs to re-authenticate: ${reason}`);
    this.name = 'ReauthRequiredError';
    this.shop = shop;
    this.reason = reason;
  }
}

/**
 * Owns every shop's offline credentials:
 *  - installs / re-installs via token exchange
 *  - hands out a valid access token, refreshing proactively (5 min before expiry)
 *  - single-flight per shop so concurrent requests never double-refresh and burn a rotated token
 */
export function createTokenManager({ store, cipher, auth, logger, trialDays = 14, refreshSkewMs = 5 * 60 * 1000, clock = Date.now }) {
  const inflight = new Map();

  function singleFlight(key, fn) {
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
      try {
        return await fn();
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, p);
    return p;
  }

  function tokenFields(tokens) {
    return {
      access_token_enc: cipher.encrypt(tokens.accessToken),
      access_token_expires_at: tokens.accessTokenExpiresAt ? tokens.accessTokenExpiresAt.toISOString() : null,
      refresh_token_enc: tokens.refreshToken ? cipher.encrypt(tokens.refreshToken) : null,
      refresh_token_expires_at: tokens.refreshTokenExpiresAt ? tokens.refreshTokenExpiresAt.toISOString() : null,
      ...(tokens.scopes ? { scopes: tokens.scopes } : {}),
    };
  }

  /** Can this row still produce an access token without a session token? */
  function hasUsableCredentials(row) {
    if (!row || row.uninstalled_at) return false;
    const access = cipher.decrypt(row.access_token_enc);
    if (!access) return false;
    const now = clock();
    const accessOk = !row.access_token_expires_at || new Date(row.access_token_expires_at).getTime() - refreshSkewMs > now;
    if (accessOk) return true;
    const refresh = cipher.decrypt(row.refresh_token_enc);
    if (!refresh) return false;
    return !row.refresh_token_expires_at || new Date(row.refresh_token_expires_at).getTime() > now;
  }

  /**
   * Called on every authenticated admin request. If we already hold working
   * credentials this is a single DB read; otherwise it installs via token exchange.
   * Returns { shop: row, installed: boolean(newly installed/reinstalled) }.
   */
  async function ensureInstalled(shopDomain, sessionToken) {
    const existing = await store.getShop(shopDomain);
    if (hasUsableCredentials(existing)) return { shop: existing, installed: false };

    return singleFlight(`install:${shopDomain}`, async () => {
      // Re-check inside the flight: a parallel request may have just installed.
      const again = await store.getShop(shopDomain);
      if (hasUsableCredentials(again)) return { shop: again, installed: false };

      const tokens = await auth.exchangeSessionToken(shopDomain, sessionToken);
      const isFresh = !again || Boolean(again.uninstalled_at);
      const fields = {
        ...tokenFields(tokens),
        uninstalled_at: null,
        ...(isFresh
          ? {
              installed_at: new Date(clock()).toISOString(),
              trial_ends_at: again?.trial_ends_at || new Date(clock() + trialDays * 86400000).toISOString(),
            }
          : {}),
      };
      const row = await store.upsertShop(shopDomain, fields);
      logger.info(isFresh ? 'shop.installed' : 'shop.reauthenticated', { shop: shopDomain, expiring: Boolean(tokens.accessTokenExpiresAt) });
      return { shop: row, installed: isFresh };
    });
  }

  /** Returns a valid access token for background/API work, refreshing if needed. */
  async function getAccessToken(shopDomain, { forceRefresh = false } = {}) {
    const row = await store.getShop(shopDomain);
    if (!row || row.uninstalled_at) throw new ReauthRequiredError(shopDomain, 'not installed');

    const access = cipher.decrypt(row.access_token_enc);
    if (!access) throw new ReauthRequiredError(shopDomain, 'no stored access token');

    const expiresAt = row.access_token_expires_at ? new Date(row.access_token_expires_at).getTime() : null;
    const needsRefresh = forceRefresh || (expiresAt !== null && expiresAt - refreshSkewMs <= clock());
    if (!needsRefresh) return access;

    return singleFlight(`refresh:${shopDomain}`, async () => {
      // Another flight may have refreshed while we waited.
      const latest = await store.getShop(shopDomain);
      const latestAccess = cipher.decrypt(latest?.access_token_enc);
      const latestExp = latest?.access_token_expires_at ? new Date(latest.access_token_expires_at).getTime() : null;
      if (!forceRefresh && latestAccess && latestExp && latestExp - refreshSkewMs > clock()) return latestAccess;

      const refreshToken = cipher.decrypt(latest?.refresh_token_enc);
      const refreshExp = latest?.refresh_token_expires_at ? new Date(latest.refresh_token_expires_at).getTime() : null;
      if (!refreshToken || (refreshExp !== null && refreshExp <= clock())) {
        await store.updateShop(shopDomain, { access_token_enc: null, access_token_expires_at: null, refresh_token_enc: null, refresh_token_expires_at: null });
        throw new ReauthRequiredError(shopDomain, 'refresh token missing or expired');
      }

      try {
        const tokens = await auth.refresh(shopDomain, refreshToken);
        // Rotation: persist BOTH new tokens atomically in one update.
        await store.updateShop(shopDomain, tokenFields(tokens));
        logger.info('shop.token_refreshed', { shop: shopDomain });
        return tokens.accessToken;
      } catch (err) {
        if (err instanceof ShopifyAuthError && err.reauth) {
          await store.updateShop(shopDomain, { access_token_enc: null, access_token_expires_at: null, refresh_token_enc: null, refresh_token_expires_at: null });
          throw new ReauthRequiredError(shopDomain, err.message);
        }
        throw err;
      }
    });
  }

  return { ensureInstalled, getAccessToken, hasUsableCredentials };
}
