import crypto from 'node:crypto';
import { safeEqual } from '../crypto.js';

const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/** Normalises and validates a *.myshopify.com domain. Returns null if invalid. */
export function sanitizeShop(input) {
  if (!input || typeof input !== 'string') return null;
  const shop = input.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return SHOP_RE.test(shop) ? shop : null;
}

// ------------------------------------------------------------------ webhooks

/** X-Shopify-Hmac-Sha256 = base64(HMAC-SHA256(secret, raw body)). */
export function verifyWebhookHmac(rawBody, hmacHeader, secret) {
  if (!hmacHeader || !Buffer.isBuffer(rawBody)) return false;
  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  return safeEqual(digest, hmacHeader);
}

// ------------------------------------------------------------------ app proxy

/**
 * App Proxy signature: remove `signature`, sort remaining params by key,
 * join each as `key=value` (multi-values joined with ','), concatenate with
 * NO separator, HMAC-SHA256 hex with the app secret.
 * @param {string} rawQuery - the raw query string (without '?')
 */
export function verifyProxySignature(rawQuery, secret) {
  const grouped = new Map();
  let signature = null;
  for (const [key, value] of new URLSearchParams(rawQuery || '')) {
    if (key === 'signature') {
      signature = value;
      continue;
    }
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(value);
  }
  if (!signature) return false;
  const message = [...grouped.keys()]
    .sort()
    .map((k) => `${k}=${grouped.get(k).join(',')}`)
    .join('');
  const digest = crypto.createHmac('sha256', secret).update(message).digest('hex');
  return safeEqual(digest, signature);
}

// ------------------------------------------------------------------ session tokens

export class SessionTokenError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SessionTokenError';
  }
}

/**
 * Verifies an App Bridge session token (JWT, HS256, signed with the app secret).
 * Returns { shop, payload }. Throws SessionTokenError on any problem.
 */
export function verifySessionToken(token, { apiKey, apiSecret, clockSkewSeconds = 10, now = Date.now() }) {
  if (!token || typeof token !== 'string') throw new SessionTokenError('Missing session token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new SessionTokenError('Malformed session token');
  const [h, p, s] = parts;

  let header;
  let payload;
  try {
    header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  } catch {
    throw new SessionTokenError('Undecodable session token');
  }
  if (header.alg !== 'HS256') throw new SessionTokenError('Unexpected token algorithm');

  const expected = crypto.createHmac('sha256', apiSecret).update(`${h}.${p}`).digest('base64url');
  if (!safeEqual(expected, s)) throw new SessionTokenError('Invalid session token signature');

  const nowSec = Math.floor(now / 1000);
  if (typeof payload.exp !== 'number' || payload.exp + clockSkewSeconds < nowSec) {
    throw new SessionTokenError('Session token expired');
  }
  if (typeof payload.nbf === 'number' && payload.nbf - clockSkewSeconds > nowSec) {
    throw new SessionTokenError('Session token not yet valid');
  }
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(apiKey)) throw new SessionTokenError('Session token audience mismatch');

  let destHost;
  let issHost;
  try {
    destHost = new URL(payload.dest).hostname;
    issHost = new URL(payload.iss).hostname;
  } catch {
    throw new SessionTokenError('Session token has invalid dest/iss');
  }
  const shop = sanitizeShop(destHost);
  if (!shop) throw new SessionTokenError('Session token dest is not a Shopify store');
  if (issHost !== destHost) throw new SessionTokenError('Session token iss/dest mismatch');

  return { shop, payload };
}
