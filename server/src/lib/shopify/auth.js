/**
 * Shopify OAuth token endpoint client.
 *  - Token exchange: App Bridge session token (id_token) → EXPIRING offline access token
 *    (mandatory for new public apps since April 1, 2026; all public apps from Jan 1, 2027).
 *  - Refresh: refresh_token → new access token + ROTATED refresh token.
 * Access tokens live 1h, refresh tokens 90d.
 */

export class ShopifyAuthError extends Error {
  constructor(message, { status = 0, code = null, reauth = false } = {}) {
    super(message);
    this.name = 'ShopifyAuthError';
    this.status = status;
    this.code = code;
    this.reauth = reauth; // true → stored credentials are dead; need a fresh session token
  }
}

function toTokens(body, now) {
  if (!body || typeof body.access_token !== 'string' || !body.access_token) {
    throw new ShopifyAuthError('Token endpoint returned no access_token');
  }
  const at = (secs) => (Number.isFinite(Number(secs)) && Number(secs) > 0 ? new Date(now + Number(secs) * 1000) : null);
  return {
    accessToken: body.access_token,
    accessTokenExpiresAt: at(body.expires_in),
    refreshToken: typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : null,
    refreshTokenExpiresAt: at(body.refresh_token_expires_in),
    scopes: typeof body.scope === 'string' ? body.scope : null,
  };
}

export function createShopifyAuth({ apiKey, apiSecret, fetchImpl = globalThis.fetch, timeoutMs = 15000, clock = Date.now }) {
  async function post(shop, payload) {
    const url = `https://${shop}/admin/oauth/access_token`;
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ client_id: apiKey, client_secret: apiSecret, ...payload }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new ShopifyAuthError(`Token endpoint unreachable: ${err.message}`);
    }

    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }

    if (!res.ok) {
      const code = body?.error || null;
      const description = body?.error_description || body?.errors || text.slice(0, 200) || res.statusText;
      // 400 invalid_grant / invalid_subject_token / 401 → credentials are dead, re-auth needed.
      const reauth = res.status === 401 || res.status === 403 || ['invalid_grant', 'invalid_subject_token', 'invalid_token'].includes(code);
      throw new ShopifyAuthError(`Token endpoint ${res.status}: ${typeof description === 'string' ? description : JSON.stringify(description)}`, {
        status: res.status,
        code,
        reauth,
      });
    }
    return toTokens(body, clock());
  }

  return {
    /** Exchange an App Bridge session token for an expiring offline access token. */
    exchangeSessionToken(shop, sessionToken) {
      return post(shop, {
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token: sessionToken,
        subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
        requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
        expiring: 1,
      });
    },

    /** Trade a refresh token for a new access token + rotated refresh token. */
    refresh(shop, refreshToken) {
      return post(shop, { grant_type: 'refresh_token', refresh_token: refreshToken });
    },
  };
}
