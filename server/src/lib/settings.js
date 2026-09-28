/**
 * Widget/merchant settings: defaults, validation and the public (storefront-safe) projection.
 * `brand_source: 'auto'` means colors/logo still follow the store's Shopify brand;
 * once the merchant edits them it flips to 'custom' and auto-sync stops overwriting.
 */

export const DEFAULT_SETTINGS = Object.freeze({
  brand_color: '#111111',
  accent_color: '#4F46E5',
  logo_url: null,
  brand_source: 'auto',
  position: 'right',
  greeting: 'Hi! How can we help?',
  ai_enabled: true,
  returns_enabled: true,
  return_window_days: 30,
  return_reasons: ['Wrong size', 'Damaged item', 'Not as described', 'Changed my mind', 'Other'],
});

const HEX_RE = /^#[0-9a-f]{6}$/i;

export function withDefaults(settings) {
  const merged = { ...DEFAULT_SETTINGS, ...(settings && typeof settings === 'object' ? settings : {}) };
  merged.return_reasons = Array.isArray(merged.return_reasons) && merged.return_reasons.length
    ? merged.return_reasons
    : [...DEFAULT_SETTINGS.return_reasons];
  return merged;
}

export class ValidationError extends Error {
  constructor(errors) {
    super('Invalid settings');
    this.name = 'ValidationError';
    this.errors = errors;
  }
}

/** Normalise a 3- or 6-digit hex; returns null when invalid. */
export function normalizeHex(value) {
  if (typeof value !== 'string') return null;
  let v = value.trim();
  if (!v.startsWith('#')) v = `#${v}`;
  if (/^#[0-9a-f]{3}$/i.test(v)) v = `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  return HEX_RE.test(v) ? v.toUpperCase() : null;
}

/**
 * Validates a partial settings patch coming from the dashboard.
 * Unknown keys are ignored. Returns the cleaned patch; throws ValidationError.
 */
export function validateSettingsPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new ValidationError({ _: 'Expected an object' });
  }
  const out = {};
  const errors = {};

  for (const key of ['brand_color', 'accent_color']) {
    if (key in patch) {
      const hex = normalizeHex(patch[key]);
      if (!hex) errors[key] = 'Must be a hex color like #4F46E5';
      else out[key] = hex;
    }
  }

  if ('logo_url' in patch) {
    const v = patch.logo_url;
    if (v === null || v === '') out.logo_url = null;
    else if (typeof v === 'string' && /^https:\/\/\S+$/i.test(v.trim()) && v.length <= 2048) out.logo_url = v.trim();
    else errors.logo_url = 'Must be an https:// image URL';
  }

  if ('position' in patch) {
    if (patch.position === 'left' || patch.position === 'right') out.position = patch.position;
    else errors.position = 'Must be "left" or "right"';
  }

  if ('greeting' in patch) {
    const g = typeof patch.greeting === 'string' ? patch.greeting.trim().replace(/\s+/g, ' ') : '';
    if (!g) errors.greeting = 'Greeting cannot be empty';
    else if (g.length > 140) errors.greeting = 'Keep the greeting under 140 characters';
    else out.greeting = g;
  }

  for (const key of ['ai_enabled', 'returns_enabled']) {
    if (key in patch) {
      if (typeof patch[key] === 'boolean') out[key] = patch[key];
      else errors[key] = 'Must be true or false';
    }
  }

  if ('return_window_days' in patch) {
    const n = Number(patch.return_window_days);
    if (!Number.isInteger(n) || n < 1 || n > 365) errors.return_window_days = 'Must be a whole number between 1 and 365';
    else out.return_window_days = n;
  }

  if ('return_reasons' in patch) {
    const list = Array.isArray(patch.return_reasons) ? patch.return_reasons : null;
    const cleaned = list
      ? [...new Set(list.map((r) => (typeof r === 'string' ? r.trim().replace(/\s+/g, ' ') : '')).filter(Boolean))]
      : [];
    if (!list || cleaned.length === 0) errors.return_reasons = 'Add at least one return reason';
    else if (cleaned.length > 10) errors.return_reasons = 'Up to 10 return reasons';
    else if (cleaned.some((r) => r.length > 60)) errors.return_reasons = 'Each reason must be under 60 characters';
    else out.return_reasons = cleaned;
  }

  if (Object.keys(errors).length) throw new ValidationError(errors);

  if ('brand_color' in out || 'accent_color' in out || 'logo_url' in out) out.brand_source = 'custom';
  return out;
}

/** What the storefront widget is allowed to see. Never includes anything private. */
export function publicWidgetConfig(shop) {
  const s = withDefaults(shop.settings);
  return {
    shop_name: shop.shop_name || null,
    brand_color: s.brand_color,
    accent_color: s.accent_color,
    logo_url: s.logo_url,
    position: s.position,
    greeting: s.greeting,
    features: {
      tracking: true,
      returns: s.returns_enabled,
      ai: s.ai_enabled,
    },
    return_window_days: s.return_window_days,
    return_reasons: s.return_reasons,
  };
}
