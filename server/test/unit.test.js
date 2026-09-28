import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createCipher, safeEqual } from '../src/lib/crypto.js';
import { sanitizeShop, verifyWebhookHmac, verifyProxySignature, verifySessionToken, SessionTokenError } from '../src/lib/shopify/verify.js';
import { validateSettingsPatch, ValidationError, withDefaults, publicWidgetConfig, normalizeHex } from '../src/lib/settings.js';
import { extractThemeColors } from '../src/services/onboarding.js';
import { idVariants } from '../src/db/store.js';
import { loadConfig } from '../src/config.js';
import { API_KEY, API_SECRET, SHOP, sessionToken, signJwt, webhookHmac } from './helpers.js';

// ---------------------------------------------------------------- crypto
test('cipher round-trips and rejects tampering / wrong key', () => {
  const c = createCipher('a-very-long-secret-value');
  const enc = c.encrypt('shpat_secret');
  assert.match(enc, /^v1\./);
  assert.notEqual(enc, c.encrypt('shpat_secret'), 'random IV per encryption');
  assert.equal(c.decrypt(enc), 'shpat_secret');

  const parts = enc.split('.');
  const flipped = Buffer.from(parts[3], 'base64url');
  flipped[0] ^= 1;
  parts[3] = flipped.toString('base64url');
  assert.equal(c.decrypt(parts.join('.')), null);
  assert.equal(createCipher('a-different-long-secret').decrypt(enc), null);
  assert.equal(c.decrypt(null), null);
  assert.equal(c.decrypt('garbage'), null);
  assert.throws(() => createCipher('short'));
});

test('safeEqual', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
});

// ---------------------------------------------------------------- shop domain
test('sanitizeShop accepts only myshopify domains', () => {
  assert.equal(sanitizeShop('Demo-Store.myshopify.com'), 'demo-store.myshopify.com');
  assert.equal(sanitizeShop('https://demo.myshopify.com/admin'), 'demo.myshopify.com');
  assert.equal(sanitizeShop('evil.com'), null);
  assert.equal(sanitizeShop('demo.myshopify.com.evil.com'), null);
  assert.equal(sanitizeShop('-bad.myshopify.com'), null);
  assert.equal(sanitizeShop(''), null);
  assert.equal(sanitizeShop(undefined), null);
});

// ---------------------------------------------------------------- webhook hmac
test('webhook HMAC', () => {
  const body = Buffer.from('{"id":1}');
  assert.equal(verifyWebhookHmac(body, webhookHmac(body), API_SECRET), true);
  assert.equal(verifyWebhookHmac(body, webhookHmac(body, 'wrong'), API_SECRET), false);
  assert.equal(verifyWebhookHmac(Buffer.from('{"id":2}'), webhookHmac(body), API_SECRET), false);
  assert.equal(verifyWebhookHmac(body, undefined, API_SECRET), false);
});

// ---------------------------------------------------------------- app proxy signature
test('app proxy signature matches Shopify documentation example', () => {
  // Example from shopify.dev "Authenticate app proxies" (secret "hush").
  const q =
    'extra=1&extra=2&shop=shop-name.myshopify.com&logged_in_customer_id=1&path_prefix=%2Fapps%2Fawesome_reviews&timestamp=1317327555&signature=4c68c8624d737112c91818c11017d24d334b524cb5c2b8ba08daa056f7395ddb';
  assert.equal(verifyProxySignature(q, 'hush'), true);
  assert.equal(verifyProxySignature(q, 'nope'), false);
  assert.equal(verifyProxySignature(q.replace('timestamp=1317327555', 'timestamp=1317327556'), 'hush'), false);
  assert.equal(verifyProxySignature('shop=x.myshopify.com', 'hush'), false);
});

// ---------------------------------------------------------------- session tokens
test('session token verification', () => {
  const opts = { apiKey: API_KEY, apiSecret: API_SECRET };
  assert.equal(verifySessionToken(sessionToken(), opts).shop, SHOP);

  const bad = (tok, re) => assert.throws(() => verifySessionToken(tok, opts), (e) => e instanceof SessionTokenError && re.test(e.message));
  bad(sessionToken({ secret: 'wrong' }), /signature/);
  bad(sessionToken({ exp: Math.floor(Date.now() / 1000) - 60 }), /expired/);
  bad(sessionToken({ aud: 'someone_else' }), /audience/);
  bad('a.b', /Malformed/);
  bad(undefined, /Missing/);

  const now = Math.floor(Date.now() / 1000);
  bad(signJwt({ iss: 'https://evil.com/admin', dest: 'https://evil.com', aud: API_KEY, exp: now + 60 }), /not a Shopify store/);
  bad(signJwt({ iss: 'https://other.myshopify.com/admin', dest: `https://${SHOP}`, aud: API_KEY, exp: now + 60 }), /mismatch/);
  bad(signJwt({ iss: `https://${SHOP}/admin`, dest: `https://${SHOP}`, aud: API_KEY, exp: now + 60, nbf: now + 120 }), /not yet valid/);

  const noneAlg = sessionToken().split('.');
  noneAlg[0] = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  bad(noneAlg.join('.'), /algorithm/);
});

// ---------------------------------------------------------------- settings
test('settings validation normalises and rejects bad input', () => {
  const ok = validateSettingsPatch({
    brand_color: 'abc',
    accent_color: '#4f46e5',
    greeting: '  Hey   there!  ',
    position: 'left',
    return_window_days: '45',
    return_reasons: [' Too small ', 'Too small', 'Late'],
    ai_enabled: false,
    unknown_key: 'ignored',
  });
  assert.deepEqual(ok, {
    brand_color: '#AABBCC',
    accent_color: '#4F46E5',
    greeting: 'Hey there!',
    position: 'left',
    return_window_days: 45,
    return_reasons: ['Too small', 'Late'],
    ai_enabled: false,
    brand_source: 'custom',
  });

  assert.throws(
    () => validateSettingsPatch({ brand_color: 'red', greeting: '', position: 'top', return_window_days: 0, return_reasons: [], logo_url: 'http://x', ai_enabled: 'yes' }),
    (e) => e instanceof ValidationError && ['brand_color', 'greeting', 'position', 'return_window_days', 'return_reasons', 'logo_url', 'ai_enabled'].every((k) => k in e.errors),
  );
  assert.throws(() => validateSettingsPatch({ greeting: 'x'.repeat(141) }), ValidationError);
  assert.throws(() => validateSettingsPatch({ return_reasons: Array.from({ length: 11 }, (_, i) => `r${i}`) }), ValidationError);
  assert.throws(() => validateSettingsPatch([]), ValidationError);
  assert.equal(validateSettingsPatch({ greeting: 'Hi' }).brand_source, undefined, 'non-brand edits keep auto sync');
  assert.equal(validateSettingsPatch({ logo_url: '' }).logo_url, null);
});

test('withDefaults + publicWidgetConfig never leak private fields', () => {
  const s = withDefaults({ greeting: 'Yo', return_reasons: [] });
  assert.equal(s.greeting, 'Yo');
  assert.equal(s.return_reasons.length, 5);
  const pub = publicWidgetConfig({ shop_name: 'Demo', settings: { brand_color: '#000000' }, access_token_enc: 'SECRET', email: 'owner@x' });
  assert.equal(JSON.stringify(pub).includes('SECRET'), false);
  assert.equal(JSON.stringify(pub).includes('owner@x'), false);
  assert.equal(pub.features.tracking, true);
  assert.equal(normalizeHex('#fff'), '#FFFFFF');
  assert.equal(normalizeHex('nope'), null);
});

// ---------------------------------------------------------------- theme parsing
test('extractThemeColors handles modern, legacy, preset and junk themes', () => {
  assert.deepEqual(
    extractThemeColors('/* comment */\n{"current":{"color_schemes":{"a":{"settings":{"button":"#ffffff"}},"b":{"settings":{"button":"#123456"}}}}}'),
    { brand_color: '#123456', accent_color: '#123456' },
  );
  assert.deepEqual(extractThemeColors('{"current":{"colors_accent_1":"#e4572e"}}'), { brand_color: '#E4572E', accent_color: '#E4572E' });
  assert.deepEqual(extractThemeColors('{"current":"Bold","presets":{"Bold":{"color_primary":"#222"}}}'), { brand_color: '#222222', accent_color: '#222222' });
  assert.deepEqual(extractThemeColors('{"current":{"header_button_bg":"#0a0"}}'), { brand_color: '#00AA00', accent_color: '#00AA00' });
  assert.equal(extractThemeColors('not json'), null);
  assert.equal(extractThemeColors('{"current":{}}'), null);
});

test('idVariants matches numeric ids and GIDs both ways', () => {
  assert.deepEqual(new Set(idVariants([123], 'Order')), new Set(['123', 'gid://shopify/Order/123']));
  assert.deepEqual(new Set(idVariants(['gid://shopify/Order/9'], 'Order')), new Set(['gid://shopify/Order/9', '9']));
  assert.deepEqual(idVariants([null, ''], 'Order'), []);
});

test('loadConfig lists every missing var and trims APP_URL', () => {
  assert.throws(() => loadConfig({}), /APP_URL, SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TOKEN_ENCRYPTION_KEY/);
  const cfg = loadConfig({
    APP_URL: 'https://app.chatwithuss.com/',
    SHOPIFY_API_KEY: 'k',
    SHOPIFY_API_SECRET: 's',
    SUPABASE_URL: 'https://x.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'srk',
    TOKEN_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
  });
  assert.equal(cfg.appUrl, 'https://app.chatwithuss.com');
  assert.equal(cfg.shopify.apiVersion, '2026-07');
});
