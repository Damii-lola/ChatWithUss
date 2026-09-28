import crypto from 'node:crypto';

const VERSION = 'v1';

/**
 * AES-256-GCM encryption for Shopify tokens at rest.
 * Key = SHA-256(TOKEN_ENCRYPTION_KEY) so any sufficiently long secret works
 * (including Render's generateValue output).
 * Ciphertext format: v1.<iv b64url>.<tag b64url>.<data b64url>
 */
export function createCipher(secret) {
  if (!secret || String(secret).length < 16) {
    throw new Error('TOKEN_ENCRYPTION_KEY must be at least 16 characters');
  }
  const key = crypto.createHash('sha256').update(String(secret)).digest();

  function encrypt(plaintext) {
    if (plaintext == null) return null;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv.toString('base64url'), tag.toString('base64url'), data.toString('base64url')].join('.');
  }

  /** Returns null (never throws) for missing/corrupt/foreign-key ciphertext → caller re-authenticates. */
  function decrypt(payload) {
    if (!payload || typeof payload !== 'string') return null;
    const parts = payload.split('.');
    if (parts.length !== 4 || parts[0] !== VERSION) return null;
    try {
      const [, ivB64, tagB64, dataB64] = parts;
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
      decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]).toString('utf8');
    } catch {
      return null;
    }
  }

  return { encrypt, decrypt };
}

/** Constant-time comparison of two strings of possibly different length. */
export function safeEqual(a, b) {
  const ab = Buffer.from(String(a ?? ''), 'utf8');
  const bb = Buffer.from(String(b ?? ''), 'utf8');
  if (ab.length !== bb.length) {
    crypto.timingSafeEqual(ab, ab); // keep timing uniform
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}
