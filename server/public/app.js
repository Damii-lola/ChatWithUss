/* ChatWithUss merchant dashboard (embedded in Shopify admin via App Bridge). */

// ------------------------------------------------------------------ utilities

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

/** Tagged template that escapes every interpolation unless wrapped in raw(). */
class Raw { constructor(v) { this.v = v; } }
const raw = (v) => new Raw(v);
function html(strings, ...values) {
  return strings.reduce((out, s, i) => {
    if (i === 0) return s;
    const v = values[i - 1];
    const str = v instanceof Raw ? v.v : Array.isArray(v) ? v.map((x) => (x instanceof Raw ? x.v : esc(x))).join('') : esc(v);
    return out + str + s;
  }, '');
}

const nf = new Intl.NumberFormat();
const hasBridge = () => typeof window.shopify?.idToken === 'function';

function toast(message, { error = false } = {}) {
  if (hasBridge() && window.shopify.toast) {
    window.shopify.toast.show(message, { isError: error, duration: 3500 });
    return;
  }
  const el = document.createElement('div');
  el.className = `toast${error ? ' toast--error' : ''}`;
  el.textContent = message;
  $('#toast-root').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function lum(hex) {
  const n = parseInt(String(hex || '#000000').slice(1), 16);
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}
const contrast = (a, b) => { const x = lum(a); const y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
/** Same rules as the storefront widget: best-reading text colour, accent darkened to AA on white. */
function textOn(hex) {
  return contrast(hex, '#FFFFFF') >= contrast(hex, '#111111') ? '#FFFFFF' : '#111111';
}
function inkOnWhite(hex) {
  let n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255, out = hex;
  for (let i = 0; i < 20 && contrast(out, '#FFFFFF') < 4.5; i++) {
    r = Math.round(r * 0.88); g = Math.round(g * 0.88); b = Math.round(b * 0.88);
    out = `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1).toUpperCase()}`;
  }
  return out;
}

function normalizeHex(value) {
  let v = String(value || '').trim();
  if (!v.startsWith('#')) v = `#${v}`;
  if (/^#[0-9a-f]{3}$/i.test(v)) v = `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  return /^#[0-9a-f]{6}$/i.test(v) ? v.toUpperCase() : null;
}

// ------------------------------------------------------------------ icons

const I = {
  check: '<svg viewBox="0 0 20 20" fill="none"><path d="M5 10.5l3.2 3L15 6.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  tick: '<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.7-9.8a.9.9 0 00-1.3-1.2L9 10.5 7.6 9.1a.9.9 0 10-1.2 1.3l2 2a.9.9 0 001.3 0l4-4.2z"/></svg>',
  bolt: '<svg viewBox="0 0 20 20" fill="currentColor"><path d="M11.3 1.5L3.8 11a.6.6 0 00.5 1h4.3l-1 6.4c-.1.6.7.9 1 .4l7.6-9.6a.6.6 0 00-.5-1H11.4l1-6.3c.1-.6-.7-.9-1.1-.4z"/></svg>',
  clock: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><circle cx="10" cy="10" r="7.5"/><path d="M10 5.5V10l3 2" stroke-linecap="round"/></svg>',
  chat: '<svg viewBox="0 0 20 20" fill="currentColor"><path d="M3 5.5A2.5 2.5 0 015.5 3h9A2.5 2.5 0 0117 5.5v6a2.5 2.5 0 01-2.5 2.5H9l-3.6 2.8c-.5.4-1.2 0-1.2-.6V14h-.2A2.5 2.5 0 013 11.5z"/></svg>',
  box: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><path d="M3 6.5L10 3l7 3.5v7L10 17l-7-3.5z"/><path d="M3 6.5L10 10l7-3.5M10 10v7"/></svg>',
  ret: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M7.5 5L4 8.5 7.5 12"/><path d="M4 8.5h8a4 4 0 010 8h-2"/></svg>',
  spark: '<svg viewBox="0 0 20 20" fill="currentColor"><path d="M10 2l1.6 4.4L16 8l-4.4 1.6L10 14l-1.6-4.4L4 8l4.4-1.6zM15.5 12.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/></svg>',
  x: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l8 8M14 6l-8 8"/></svg>',
  info: '<svg viewBox="0 0 20 20" fill="currentColor"><path d="M10 18a8 8 0 100-16 8 8 0 000 16zm0-11.3a1.1 1.1 0 110-2.2 1.1 1.1 0 010 2.2zM9 9a1 1 0 012 0v5a1 1 0 11-2 0z"/></svg>',
  refresh: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4v4h-4"/><path d="M15.5 8A6 6 0 104 11"/></svg>',
  chev: '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M8 5l5 5-5 5"/></svg>',
};

// ------------------------------------------------------------------ API

class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || `Request failed (${status})`);
    this.status = status;
    this.body = body;
  }
}

async function api(path, { method = 'GET', body } = {}, attempt = 0) {
  const token = await window.shopify.idToken();
  const res = await fetch(path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && res.headers.get('X-Shopify-Retry-Invalid-Session-Request') && attempt < 1) {
    return api(path, { method, body }, attempt + 1); // App Bridge hands out a fresh token on the next idToken()
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

// ------------------------------------------------------------------ state & routing

const state = {
  me: null,
  stats: null,
  statsError: false,
  saved: null, // last persisted settings
  draft: null, // settings being edited
  errors: {},
  saving: false,
  syncing: false,
  widget: null, // { live, embed_enabled, theme, seen_at }
};

const routeName = () => ((location.pathname.replace(/\/+$/, '') || '/') === '/settings' ? 'settings' : 'home');

function navigate(path) {
  if (routeName() === 'settings' && isDirty() && !confirm('You have unsaved changes. Leave without saving?')) return;
  history.pushState({}, '', path + location.search);
  hideSaveBar();
  render();
  window.scrollTo(0, 0);
}

window.addEventListener('popstate', render);
// App Bridge dispatches this when a ui-nav-menu link is clicked.
document.addEventListener('shopify:navigate', (e) => {
  const href = e.detail?.href || e.target?.getAttribute?.('href');
  if (!href) return;
  const url = new URL(href, location.origin);
  history.pushState({}, '', url.pathname + location.search);
  render();
});

document.addEventListener('click', (e) => {
  const act = e.target.closest('[data-act="recheck-widget"]');
  if (act) {
    act.disabled = true;
    act.textContent = 'Checking…';
    loadWidgetStatus().then(() => {
      if (state.widget?.live) toast('Chat widget is live on your store');
      else toast('Not on yet. Switch it on in App embeds and click Save.', { error: true });
    });
    return;
  }
  const link = e.target.closest('[data-nav]');
  if (link) {
    e.preventDefault();
    navigate(link.getAttribute('data-nav'));
  }
});

// ------------------------------------------------------------------ boot

async function boot() {
  if (!hasBridge()) return renderOutsideAdmin();
  try {
    state.me = await api('/api/me');
    resetDraft();
    render();
    loadStats();
    loadWidgetStatus();
  } catch (err) {
    renderFatal(err);
  }
}

async function loadWidgetStatus() {
  try {
    state.widget = await api('/api/widget-status');
  } catch {
    state.widget = { live: false, embed_enabled: null };
  }
  if (routeName() === 'home') render();
}

// Merchant flips the embed on in the theme editor tab, comes back → re-check automatically.
window.addEventListener('focus', () => {
  if (state.me && state.widget && !state.widget.live) loadWidgetStatus();
});

async function loadStats() {
  try {
    state.stats = await api('/api/stats?days=30');
    state.statsError = false;
  } catch {
    state.statsError = true;
  }
  if (routeName() === 'home') render();
}

function resetDraft() {
  state.saved = structuredClone(state.me.settings);
  state.draft = structuredClone(state.me.settings);
  state.errors = {};
}

function render() {
  if (!state.me) return;
  const app = $('#app');
  if (routeName() === 'settings') {
    app.innerHTML = settingsView();
    bindSettings();
    updatePreview();
    updateDirty();
  } else {
    app.innerHTML = homeView();
  }
  document.title = routeName() === 'settings' ? 'Widget settings · ChatWithUss' : 'ChatWithUss';
}

// ------------------------------------------------------------------ home

function greetingWord() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function trialBadge(shop) {
  if (shop.billing_status === 'active') return html`<span class="badge badge--success badge--dot">Active plan</span>`;
  if (!shop.trial_ends_at) return '';
  const days = Math.ceil((new Date(shop.trial_ends_at) - Date.now()) / 86400000);
  if (days <= 0) return html`<span class="badge badge--warning badge--dot">Trial ended</span>`;
  return html`<span class="badge badge--info badge--dot">${days} ${days === 1 ? 'day' : 'days'} left in trial</span>`;
}

function statTile({ icon, label, value, hint, attention = false }) {
  return html`
    <div class="card stat${attention ? ' stat--attention' : ''}">
      <div class="stat__label"><span class="stat__icon">${raw(icon)}</span>${label}</div>
      <div class="stat__value">${value}</div>
      <div class="stat__hint">${hint}</div>
    </div>`;
}

function statsTiles() {
  const s = state.stats;
  if (state.statsError) {
    return html`<div class="banner banner--critical">${raw(I.info)}<div><div class="banner__title">Couldn't load your numbers</div><div>Refresh the page to try again.</div></div></div>`;
  }
  if (!s) return html`<div class="grid grid--stats">${raw('<div class="card skeleton skeleton--tile"></div>'.repeat(4))}</div>`;
  return html`
    <div class="grid grid--stats">
      ${raw(statTile({ icon: I.bolt, label: 'Resolved automatically', value: nf.format(s.deflected), hint: 'Last 30 days, no human needed' }))}
      ${raw(statTile({ icon: I.clock, label: 'Time saved', value: `${s.hours_saved}h`, hint: `≈ ${s.minutes_per_ticket} min per ticket` }))}
      ${raw(statTile({ icon: I.chat, label: 'Waiting on you', value: nf.format(s.open_conversations), hint: s.open_conversations ? 'Shoppers asked for a human' : 'All caught up', attention: s.open_conversations > 0 }))}
      ${raw(statTile({ icon: I.ret, label: 'Return requests', value: nf.format(s.pending_returns), hint: s.pending_returns ? 'Pending your approval' : 'Nothing pending', attention: s.pending_returns > 0 }))}
    </div>`;
}

const TYPE_LABELS = {
  tracking_lookup: 'Order tracking',
  return_request: 'Return requests',
  ai_answer: 'AI answers',
  agent_reply: 'Agent replies',
  order_cancel: 'Cancellations',
  refund: 'Refunds',
  address_update: 'Address changes',
};

function breakdownCard() {
  const s = state.stats;
  let body;
  if (!s) body = '<div class="skeleton" style="height:150px"></div>';
  else if (!s.total) {
    body = html`
      <div class="empty">
        <div class="empty__icon">${raw(I.chat)}</div>
        <div class="empty__title">No conversations yet</div>
        <p>Every question your widget answers shows up here, split by type, so you can see exactly what it handles for you.</p>
      </div>`;
  } else {
    const max = Math.max(...Object.values(s.by_type), 1);
    body = html`<div class="bars">${Object.entries(s.by_type)
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([type, n]) => raw(html`
        <div class="bar__row">
          <span class="bar__label">${TYPE_LABELS[type] || type}</span>
          <span class="bar__track"><span class="bar__fill" style="width:${Math.max(3, Math.round((n / max) * 100))}%"></span></span>
          <span class="bar__value">${nf.format(n)}</span>
        </div>`))}</div>`;
  }
  return html`
    <div class="card">
      <div class="card__header">
        <div><div class="card__title">What ChatWithUss handled</div><div class="card__subtitle">Last 30 days</div></div>
        ${s?.total ? raw(html`<span class="badge">${nf.format(s.total)} total</span>`) : ''}
      </div>
      ${raw(body)}
    </div>`;
}

function setupGuide() {
  const { shop, settings } = state.me;
  const steps = [
    {
      done: true,
      title: 'Connect your store',
      desc: `ChatWithUss can read orders, fulfillments and store policies from ${shop.name}.`,
    },
    {
      done: Boolean(state.widget?.live),
      pending: state.widget === null,
      title: 'Turn on the chat widget',
      desc: state.widget?.embed_enabled === false
        ? `It's switched off in your ${state.widget.theme ? `"${state.widget.theme}" ` : ''}theme. Open the theme editor, switch on "ChatWithUss chat" under App embeds, then click Save.`
        : 'One click: open the theme editor, make sure "ChatWithUss chat" is on under App embeds, then click Save.',
      action: { label: 'Turn on in theme editor', href: state.me.app.theme_editor_url },
      secondary: { label: 'Check again', act: 'recheck-widget' },
    },
    {
      done: Boolean(shop.brand_synced_at || settings.brand_source === 'custom'),
      title: 'Match your brand',
      desc: 'Your logo and colors are pulled from Shopify automatically. Fine-tune them anytime.',
      action: { label: 'Customize appearance', nav: '/settings' },
    },
    {
      done: Boolean(settings.settings_saved_at),
      title: 'Set your return rules',
      desc: `Shoppers can request returns within ${settings.return_window_days} days, using reasons you choose.`,
      action: { label: 'Review return rules', nav: '/settings' },
    },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  if (doneCount === steps.length) return '';
  const firstOpen = steps.findIndex((s) => !s.done);

  return html`
    <div class="card">
      <div class="card__header">
        <div>
          <div class="card__title">Setup guide</div>
          <div class="card__subtitle">Most stores finish this in under 5 minutes.</div>
        </div>
        <div class="guide__progress">
          <span>${doneCount} of ${steps.length} done</span>
          <span class="progress"><span class="progress__bar" style="width:${Math.round((doneCount / steps.length) * 100)}%"></span></span>
        </div>
      </div>
      <ol class="guide__list">
        ${steps.map((s, i) => raw(html`
          <li class="guide__item${s.done ? ' guide__item--done' : ''}${i === firstOpen ? ' guide__item--active' : ''}">
            <span class="guide__check">${s.done ? raw(I.check) : ''}</span>
            <div>
              <div class="guide__title">${s.title}</div>
              ${i === firstOpen || !s.done ? raw(html`<div class="guide__desc">${s.desc}</div>`) : ''}
            </div>
            ${!s.done && s.action
              ? raw(html`<div class="guide__actions">
                  ${s.secondary && i === firstOpen ? raw(html`<button class="btn btn--plain" data-act="${s.secondary.act}">${s.secondary.label}</button>`) : ''}
                  ${s.action.href
                    ? raw(html`<a class="btn ${i === firstOpen ? 'btn--primary' : 'btn--secondary'}" href="${s.action.href}" target="_top">${s.action.label}</a>`)
                    : raw(html`<button class="btn ${i === firstOpen ? 'btn--primary' : 'btn--secondary'}" data-nav="${s.action.nav}">${s.action.label}</button>`)}
                </div>`)
              : ''}
          </li>`))}
      </ol>
    </div>`;
}

function planCard() {
  const { shop } = state.me;
  return html`
    <div class="card">
      <div class="card__header"><div class="card__title">Your plan</div>${raw(trialBadge(shop))}</div>
      <div class="plan__price">$15<small> / month, flat</small></div>
      <p class="muted" style="margin-top:4px">Unlimited resolutions. No per-ticket fees, ever.</p>
      <ul class="checklist">
        <li>${raw(I.tick)}<span>Unlimited order tracking lookups</span></li>
        <li>${raw(I.tick)}<span>Self-serve returns &amp; exchanges portal</span></li>
        <li>${raw(I.tick)}<span>AI answers trained on your store policies</span></li>
        <li>${raw(I.tick)}<span>Cancel, refund &amp; edit orders without leaving the inbox</span></li>
      </ul>
    </div>`;
}

function homeView() {
  const { shop } = state.me;
  return html`
    <div class="page">
      <header class="page-header">
        <div>
          <h1>${greetingWord()}, ${shop.name}</h1>
          <p>Here's what ChatWithUss took off your plate this month.</p>
        </div>
        <div class="page-header__actions">
          <button class="btn btn--secondary" data-nav="/settings">Widget settings</button>
        </div>
      </header>
      ${raw(setupGuide())}
      ${raw(statsTiles())}
      <div class="grid grid--two">
        ${raw(breakdownCard())}
        ${raw(planCard())}
      </div>
    </div>`;
}

// ------------------------------------------------------------------ settings

function fieldError(key) {
  return state.errors[key] ? html`<div class="field__error" data-error-for="${key}">${state.errors[key]}</div>` : html`<div data-error-for="${key}"></div>`;
}

function colorField(key, label, help) {
  const v = state.draft[key];
  return html`
    <div class="field">
      <label class="field__label" for="f-${key}">${label}</label>
      <div class="color-field">
        <label class="color-swatch" style="background:${v}" data-swatch="${key}">
          <input type="color" value="${v}" data-color-picker="${key}" aria-label="${label} picker" />
        </label>
        <input id="f-${key}" class="input${state.errors[key] ? ' input--error' : ''}" value="${v}" maxlength="7" spellcheck="false" data-color-text="${key}" />
      </div>
      <div class="field__help">${help}</div>
      ${raw(fieldError(key))}
    </div>`;
}

function toggleRow(key, title, desc, soon = false) {
  return html`
    <div class="toggle-row">
      <div><div class="field__label">${title}${soon ? raw(' <span class="badge badge--info">Launching soon</span>') : ''}</div><div class="field__help">${desc}${soon ? ' Turn it on now and it goes live automatically when it ships.' : ''}</div></div>
      <span class="switch">
        <input type="checkbox" role="switch" data-toggle="${key}" ${state.draft[key] ? 'checked' : ''} aria-label="${title}" />
        <span class="switch__track"></span>
      </span>
    </div>`;
}

function reasonsChips() {
  return state.draft.return_reasons
    .map((r, i) => html`<span class="chip">${r}<button type="button" data-remove-reason="${i}" aria-label="Remove ${r}">${raw(I.x)}</button></span>`)
    .join('');
}

function settingsView() {
  const d = state.draft;
  const { shop } = state.me;
  return html`
    <div class="page page--wide">
      <header class="page-header">
        <div>
          <h1>Widget settings</h1>
          <p>Changes go live on your storefront as soon as you save.</p>
        </div>
      </header>

      <div class="grid grid--settings">
        <form class="stack" id="settings-form" novalidate>
          <section class="card">
            <div class="card__header">
              <div>
                <div class="card__title">Appearance</div>
                <div class="card__subtitle" id="brand-source">${brandSourceLabel()}</div>
              </div>
              <button type="button" class="btn btn--plain" id="brand-sync" ${state.syncing ? 'disabled' : ''}>
                ${state.syncing ? raw('<span class="spinner"></span>') : raw(I.refresh)} Re-sync from store
              </button>
            </div>
            ${raw(colorField('brand_color', 'Header color', 'Background of the widget header.'))}
            ${raw(colorField('accent_color', 'Accent color', 'Chat bubble, buttons and highlights.'))}
            <div class="field">
              <label class="field__label" for="f-logo">Logo URL</label>
              <div class="logo-field">
                <span class="logo-thumb" id="logo-thumb"></span>
                <input id="f-logo" class="input${state.errors.logo_url ? ' input--error' : ''}" value="${d.logo_url || ''}" placeholder="https://cdn.shopify.com/…/logo.png" data-text="logo_url" />
              </div>
              <div class="field__help">Leave empty to show your store's initial instead.</div>
              ${raw(fieldError('logo_url'))}
            </div>
            <div class="field">
              <span class="field__label">Position</span>
              <div class="segmented" role="group" aria-label="Widget position">
                <button type="button" data-position="left" aria-pressed="${d.position === 'left'}">Bottom left</button>
                <button type="button" data-position="right" aria-pressed="${d.position === 'right'}">Bottom right</button>
              </div>
            </div>
            <div class="field">
              <label class="field__label" for="f-greeting">Greeting</label>
              <textarea id="f-greeting" class="textarea${state.errors.greeting ? ' input--error' : ''}" maxlength="140" rows="2" data-text="greeting">${d.greeting}</textarea>
              <div class="row row--between">${raw(fieldError('greeting'))}<span class="field__counter" id="greeting-count">${d.greeting.length}/140</span></div>
            </div>
          </section>

          <section class="card">
            <div class="card__header"><div class="card__title">Features</div></div>
            ${raw(toggleRow('returns_enabled', 'Returns portal', 'Shoppers pick items and a reason; you approve with one click.', !state.me.live_features?.returns))}
            ${raw(toggleRow('ai_enabled', 'AI answers', `Instant answers about shipping, sizing and policies, trained on ${shop.name}'s pages.`, !state.me.live_features?.ai))}
          </section>

          <section class="card" id="returns-card" ${d.returns_enabled ? '' : 'hidden'}>
            <div class="card__header"><div><div class="card__title">Return rules</div><div class="card__subtitle">Match these to your store's refund policy.</div></div></div>
            <div class="field">
              <label class="field__label" for="f-window">Return window</label>
              <div class="input-group" style="max-width:260px">
                <input id="f-window" type="number" min="1" max="365" step="1" class="input input--number${state.errors.return_window_days ? ' input--error' : ''}" value="${d.return_window_days}" data-number="return_window_days" />
                <span class="suffix">days after delivery</span>
              </div>
              ${raw(fieldError('return_window_days'))}
            </div>
            <div class="field">
              <label class="field__label" for="f-reason">Return reasons</label>
              <div class="chips" id="reason-chips">${raw(reasonsChips())}</div>
              <div class="input-group" style="margin-top:6px">
                <input id="f-reason" class="input" maxlength="60" placeholder="Add a reason, e.g. Arrived late" />
                <button type="button" class="btn btn--secondary" id="add-reason">Add</button>
              </div>
              <div class="field__help">Up to 10. Shoppers must pick one when requesting a return.</div>
              ${raw(fieldError('return_reasons'))}
            </div>
          </section>

          <div class="inline-save">
            <button type="button" class="btn btn--secondary" id="discard-btn" disabled>Discard</button>
            <button type="submit" class="btn btn--primary" id="save-btn" disabled>Save</button>
          </div>
        </form>

        <aside class="preview-sticky">
          <div class="card">
            <div class="card__header"><div><div class="card__title">Live preview</div><div class="card__subtitle">How shoppers see it on mobile</div></div></div>
            <div class="preview-stage" id="preview"></div>
          </div>
        </aside>
      </div>
    </div>`;
}

function previewMarkup() {
  const d = state.draft;
  const brand = normalizeHex(d.brand_color) || '#111111';
  const accent = normalizeHex(d.accent_color) || '#4F46E5';
  const onBrand = textOn(brand);
  const onAccent = textOn(accent);
  const ink = inkOnWhite(accent);
  const name = state.me.shop.name;
  const logo = /^https:\/\//i.test(d.logo_url || '') ? d.logo_url.replace(/['"()\\\s]/g, (c) => encodeURIComponent(c)) : null;
  const live = state.me.live_features || {};
  const actions = [
    { icon: I.box, title: 'Track my order', sub: 'Live delivery status' },
    d.returns_enabled && { icon: I.ret, title: 'Start a return', sub: `Within ${d.return_window_days} days`, soon: !live.returns },
    d.ai_enabled && { icon: I.spark, title: 'Ask a question', sub: 'Instant answers, 24/7', soon: !live.ai },
  ].filter(Boolean);
  const side = d.position === 'left' ? 'left' : 'right';

  return html`
    <div class="preview-stage__site" aria-hidden="true">
      <span style="width:40%"></span><span style="width:85%"></span><span style="width:70%"></span><span style="width:55%"></span>
    </div>
    <div class="w-panel w-panel--${side}">
      <div class="w-head" style="background:${brand};color:${onBrand}">
        <div class="w-head__top">
          ${logo
            ? raw(html`<span class="w-logo w-logo--img" style="background-image:url('${logo}')"></span>`)
            : raw(html`<span class="w-logo">${name.charAt(0).toUpperCase()}</span>`)}
          <div><div class="w-shop">${name}</div><div class="w-status">${state.me.live_features?.ai && d.ai_enabled ? 'Instant answers, 24/7' : 'Order help, anytime'}</div></div>
        </div>
        <div class="w-greeting">${d.greeting || ' '}</div>
      </div>
      <div class="w-body">
        ${actions.filter((a) => !a.soon).length === 1
          ? raw(html`
            <div class="w-label">Where’s my order?</div>
            <div class="w-form">
              <div class="w-field-label">Order number</div><div class="w-input">e.g. #1001</div>
              <div class="w-field-label">Email used at checkout</div><div class="w-input">you@example.com</div>
              <div class="w-btn" style="background:${accent};color:${onAccent}">Track order</div>
            </div>
            ${actions.filter((a) => a.soon).length
              ? raw(html`<div class="w-soon-note">Coming soon: ${actions.filter((a) => a.soon).map((a) => a.title).join(' · ')}</div>`)
              : ''}`)
          : actions.map((a) => raw(html`
          <div class="w-action">
            <span class="w-action__icon" style="background:${ink}1F;color:${ink}">${raw(a.icon)}</span>
            <span class="w-action__text">${a.title}<small>${a.sub}</small></span>
            ${a.soon ? raw('<span class="w-soon">Soon</span>') : raw(html`<span class="w-action__chev">${raw(I.chev)}</span>`)}
          </div>`))}
      </div>
      <div class="w-foot">Powered by ChatWithUss</div>
    </div>
    <div class="w-launcher w-launcher--${side}" style="background:${accent};color:${onAccent}">${raw(I.chat)}</div>`;
}

function updatePreview() {
  const el = $('#preview');
  if (el) el.innerHTML = previewMarkup();
  const thumb = $('#logo-thumb');
  if (thumb) {
    const ok = /^https:\/\//i.test(state.draft.logo_url || '');
    thumb.style.backgroundImage = ok ? `url("${state.draft.logo_url.replace(/['"()\\\s]/g, (c) => encodeURIComponent(c))}")` : '';
  }
}

const COMPARE_KEYS = ['brand_color', 'accent_color', 'logo_url', 'position', 'greeting', 'ai_enabled', 'returns_enabled', 'return_window_days', 'return_reasons'];
function isDirty() {
  if (!state.draft || !state.saved) return false;
  return COMPARE_KEYS.some((k) => JSON.stringify(state.draft[k] ?? null) !== JSON.stringify(state.saved[k] ?? null));
}

function showSaveBar() { if (hasBridge() && window.shopify.saveBar) window.shopify.saveBar.show('settings-save-bar').catch?.(() => {}); }
function hideSaveBar() { if (hasBridge() && window.shopify.saveBar) window.shopify.saveBar.hide('settings-save-bar').catch?.(() => {}); }

function updateDirty() {
  const dirty = isDirty();
  const save = $('#save-btn');
  const discard = $('#discard-btn');
  if (save) save.disabled = !dirty || state.saving;
  if (discard) discard.disabled = !dirty || state.saving;
  if (routeName() === 'settings' && dirty) showSaveBar();
  else hideSaveBar();
}

function setFieldError(key, message) {
  if (message) state.errors[key] = message;
  else delete state.errors[key];
  const slot = $(`[data-error-for="${key}"]`);
  if (slot) {
    slot.className = message ? 'field__error' : '';
    slot.textContent = message || '';
  }
}

function brandSourceLabel() {
  const brandEdited = ['brand_color', 'accent_color', 'logo_url'].some((k) => state.draft[k] !== state.saved[k]);
  if (brandEdited) return 'Custom colors · unsaved';
  return state.draft.brand_source === 'custom' ? 'Custom colors' : 'Synced from your Shopify brand settings';
}

function change(key, value) {
  state.draft[key] = value;
  const src = $('#brand-source');
  if (src) src.textContent = brandSourceLabel();
  if (state.errors[key]) setFieldError(key, null);
  updatePreview();
  updateDirty();
}

function bindSettings() {
  const form = $('#settings-form');

  $$('[data-color-picker]').forEach((picker) => {
    const key = picker.dataset.colorPicker;
    picker.addEventListener('input', () => {
      const hex = picker.value.toUpperCase();
      $(`[data-color-text="${key}"]`).value = hex;
      $(`[data-color-text="${key}"]`).classList.remove('input--error');
      $(`[data-swatch="${key}"]`).style.background = hex;
      change(key, hex);
    });
  });

  $$('[data-color-text]').forEach((input) => {
    const key = input.dataset.colorText;
    input.addEventListener('input', () => {
      const hex = normalizeHex(input.value);
      if (hex) {
        $(`[data-swatch="${key}"]`).style.background = hex;
        $(`[data-color-picker="${key}"]`).value = hex.toLowerCase();
        input.classList.remove('input--error');
        change(key, hex);
      }
    });
    input.addEventListener('blur', () => {
      const hex = normalizeHex(input.value);
      if (!hex) {
        input.classList.add('input--error');
        setFieldError(key, 'Use a hex color like #4F46E5');
      } else {
        input.value = hex;
      }
    });
  });

  $$('[data-text]').forEach((input) => {
    const key = input.dataset.text;
    input.addEventListener('input', () => {
      input.classList.remove('input--error');
      if (key === 'greeting') $('#greeting-count').textContent = `${input.value.length}/140`;
      change(key, key === 'logo_url' ? input.value.trim() || null : input.value);
    });
  });

  $$('[data-number]').forEach((input) => {
    const key = input.dataset.number;
    input.addEventListener('input', () => {
      input.classList.remove('input--error');
      const n = Number(input.value);
      change(key, Number.isInteger(n) ? n : input.value);
    });
  });

  $$('[data-toggle]').forEach((input) => {
    const key = input.dataset.toggle;
    input.addEventListener('change', () => {
      change(key, input.checked);
      if (key === 'returns_enabled') $('#returns-card').hidden = !input.checked;
    });
  });

  $$('[data-position]').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('[data-position]').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      change('position', btn.dataset.position);
    });
  });

  const reasonInput = $('#f-reason');
  const addReason = () => {
    const value = reasonInput.value.trim().replace(/\s+/g, ' ');
    if (!value) return;
    const list = state.draft.return_reasons;
    if (list.some((r) => r.toLowerCase() === value.toLowerCase())) return setFieldError('return_reasons', 'That reason is already on the list');
    if (list.length >= 10) return setFieldError('return_reasons', 'Up to 10 return reasons');
    change('return_reasons', [...list, value]);
    reasonInput.value = '';
    $('#reason-chips').innerHTML = reasonsChips();
  };
  $('#add-reason').addEventListener('click', addReason);
  reasonInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addReason();
    }
  });
  $('#reason-chips').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-reason]');
    if (!btn) return;
    const i = Number(btn.dataset.removeReason);
    if (state.draft.return_reasons.length <= 1) return setFieldError('return_reasons', 'Keep at least one reason');
    change('return_reasons', state.draft.return_reasons.filter((_, idx) => idx !== i));
    $('#reason-chips').innerHTML = reasonsChips();
  });

  $('#brand-sync').addEventListener('click', syncBrand);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    save();
  });
  $('#discard-btn').addEventListener('click', discard);
}

async function save() {
  if (!isDirty() || state.saving) return;
  state.saving = true;
  updateDirty();
  const btn = $('#save-btn');
  if (btn) btn.innerHTML = '<span class="spinner"></span> Saving';

  const patch = {};
  for (const k of COMPARE_KEYS) {
    if (JSON.stringify(state.draft[k] ?? null) !== JSON.stringify(state.saved[k] ?? null)) patch[k] = state.draft[k];
  }

  try {
    const res = await api('/api/settings', { method: 'PUT', body: patch });
    state.me.settings = res.settings;
    resetDraft();
    hideSaveBar();
    toast('Settings saved');
    state.saving = false;
    render();
  } catch (err) {
    state.saving = false;
    if (err.status === 422 && err.body?.errors) {
      state.errors = err.body.errors;
      render();
      toast('Fix the highlighted fields', { error: true });
    } else {
      if (btn) btn.textContent = 'Save';
      updateDirty();
      toast(err.status === 502 ? 'Shopify is not responding. Try again.' : "Couldn't save. Try again.", { error: true });
    }
  }
}

function discard() {
  resetDraft();
  hideSaveBar();
  render();
}

async function syncBrand() {
  if (state.syncing) return;
  state.syncing = true;
  render();
  try {
    const res = await api('/api/brand/sync', { method: 'POST' });
    state.me.shop = res.shop;
    state.me.settings = res.settings;
    // keep unrelated unsaved edits, replace only brand fields
    const keep = { ...state.draft };
    resetDraft();
    for (const k of ['position', 'greeting', 'ai_enabled', 'returns_enabled', 'return_window_days', 'return_reasons']) state.draft[k] = keep[k];
    toast(res.brand_found ? 'Brand synced from your store' : 'No brand set in Shopify yet, using defaults');
  } catch {
    toast("Couldn't reach your store. Try again.", { error: true });
  } finally {
    state.syncing = false;
    render();
  }
}

// App Bridge contextual save bar buttons
$('#savebar-save')?.addEventListener('click', save);
$('#savebar-discard')?.addEventListener('click', discard);

// ------------------------------------------------------------------ fallback screens

function renderOutsideAdmin() {
  $('#app').innerHTML = html`
    <div class="page" style="max-width:520px;padding-top:12vh">
      <div class="card" style="text-align:center;padding:32px 24px">
        <div class="empty__icon">${raw(I.chat)}</div>
        <h1 style="font-size:18px;margin-bottom:6px;color:var(--text-strong)">Open ChatWithUss from Shopify</h1>
        <p class="muted">This dashboard runs inside your Shopify admin. Go to <b>Apps → ChatWithUss</b> in your store's admin to continue.</p>
      </div>
    </div>`;
}

function renderFatal(err) {
  $('#app').innerHTML = html`
    <div class="page" style="max-width:560px;padding-top:10vh">
      <div class="banner banner--critical">
        ${raw(I.info)}
        <div>
          <div class="banner__title">ChatWithUss couldn't load</div>
          <div>${err?.status === 502 ? 'Shopify is not responding right now.' : 'Something went wrong while connecting to your store.'} Reload the page to try again.</div>
          <div style="margin-top:10px"><button class="btn btn--secondary" onclick="location.reload()">Reload</button></div>
        </div>
      </div>
    </div>`;
}

boot();
