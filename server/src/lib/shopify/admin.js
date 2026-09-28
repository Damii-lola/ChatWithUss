import { ReauthRequiredError } from './tokens.js';

export class ShopifyApiError extends Error {
  constructor(message, { status = 0, errors = null } = {}) {
    super(message);
    this.name = 'ShopifyApiError';
    this.status = status;
    this.errors = errors;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Admin GraphQL client bound to one shop.
 * - Gets its token from the token manager (auto-refresh of expiring tokens)
 * - 401 → forces one refresh + retry, then surfaces ReauthRequiredError
 * - 429 / THROTTLED / 5xx / network → exponential backoff, max 4 attempts
 */
export function createAdminClient({ shop, tokens, apiVersion, fetchImpl = globalThis.fetch, logger, timeoutMs = 20000, sleepImpl = sleep }) {
  const endpoint = `https://${shop}/admin/api/${apiVersion}/graphql.json`;

  async function graphql(query, variables = {}, { maxAttempts = 4 } = {}) {
    let forcedRefresh = false;

    for (let attempt = 1; ; attempt++) {
      const accessToken = await tokens.getAccessToken(shop, { forceRefresh: false });
      let res;
      try {
        res = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-Shopify-Access-Token': accessToken,
          },
          body: JSON.stringify({ query, variables }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        if (attempt >= maxAttempts) throw new ShopifyApiError(`Shopify unreachable: ${err.message}`);
        await sleepImpl(backoff(attempt));
        continue;
      }

      if (res.status === 401) {
        if (forcedRefresh) throw new ReauthRequiredError(shop, 'Admin API returned 401 after refresh');
        forcedRefresh = true;
        await tokens.getAccessToken(shop, { forceRefresh: true });
        continue;
      }

      if (res.status === 402) throw new ShopifyApiError('Shop is frozen or unpaid (402)', { status: 402 });
      if (res.status === 403) throw new ShopifyApiError('Access denied — missing scope or protected customer data approval (403)', { status: 403 });
      if (res.status === 404) throw new ShopifyApiError('Shop or API version not found (404)', { status: 404 });

      if (res.status === 429 || res.status >= 500) {
        if (attempt >= maxAttempts) throw new ShopifyApiError(`Shopify API ${res.status} after ${attempt} attempts`, { status: res.status });
        const retryAfter = Number(res.headers.get('retry-after'));
        await sleepImpl(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt));
        continue;
      }

      const body = await res.json().catch(() => null);
      if (!body) throw new ShopifyApiError('Shopify returned a non-JSON response', { status: res.status });

      if (Array.isArray(body.errors) && body.errors.length) {
        const throttled = body.errors.some((e) => e?.extensions?.code === 'THROTTLED');
        if (throttled && attempt < maxAttempts) {
          const cost = body.extensions?.cost;
          const needed = cost?.requestedQueryCost ?? 100;
          const available = cost?.throttleStatus?.currentlyAvailable ?? 0;
          const rate = cost?.throttleStatus?.restoreRate || 50;
          await sleepImpl(Math.max(500, Math.ceil(((needed - available) / rate) * 1000)));
          continue;
        }
        const message = body.errors.map((e) => e?.message).filter(Boolean).join('; ') || 'GraphQL error';
        logger?.warn('shopify.graphql_error', { shop, message });
        throw new ShopifyApiError(message, { status: res.status, errors: body.errors });
      }

      return body.data;
    }
  }

  return { graphql, shop };
}

function backoff(attempt) {
  return Math.min(8000, 400 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
}
