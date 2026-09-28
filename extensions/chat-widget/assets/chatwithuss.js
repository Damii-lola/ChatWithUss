/* ChatWithUss storefront widget \u2014 theme app extension (app embed). No dependencies. */
(function () {
  'use strict';
  if (window.__chatwithuss) return;
  window.__chatwithuss = true;

  var root = document.getElementById('chatwithuss-root');
  if (!root) return;
  var ds = root.dataset;
  var PROXY = (ds.proxy || '/apps/chatwithuss').replace(/\/+$/, '');
  var LOCALE = ds.locale || document.documentElement.lang || 'en';
  var LOGGED_IN = ds.loggedIn === 'true';
  var DESIGN_MODE = ds.designMode === 'true';
  var MOBILE_Q = window.matchMedia('(max-width: 560px)');

  if (ds.hideOnMobile === 'true' && window.matchMedia('(max-width: 749px)').matches && !DESIGN_MODE) return;

  // ------------------------------------------------------------------ helpers
  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return ESC[c]; }); }
  function safeUrl(u) { return /^https?:\/\//i.test(u || '') ? esc(u) : '#'; }
  function hex(v, fallback) { return /^#[0-9a-f]{6}$/i.test(v || '') ? v : fallback; }
  function lum(h) {
    var n = parseInt(h.slice(1), 16);
    var lin = function (c) { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  }
  function contrast(a, b) { var x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
  /** Text colour for a background: whichever of white / near-black reads better. */
  function onColor(h) { return contrast(h, '#FFFFFF') >= contrast(h, '#111111') ? '#FFFFFF' : '#111111'; }
  /** Accent usable as text/lines on white: darken until WCAG AA (4.5:1). */
  function inkOnWhite(h) {
    var n = parseInt(h.slice(1), 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255, out = h;
    for (var i = 0; i < 20 && contrast(out, '#FFFFFF') < 4.5; i++) {
      r = Math.round(r * 0.88); g = Math.round(g * 0.88); b = Math.round(b * 0.88);
      out = '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1).toUpperCase();
    }
    return out;
  }
  function fmtDate(iso, withYear) {
    if (!iso) return '';
    try {
      var o = { weekday: 'short', month: 'short', day: 'numeric' };
      if (withYear) { o = { month: 'short', day: 'numeric', year: 'numeric' }; }
      return new Intl.DateTimeFormat(LOCALE, o).format(new Date(iso));
    } catch (e) { return new Date(iso).toDateString(); }
  }
  function fmtMoney(total) {
    if (!total) return '';
    try { return new Intl.NumberFormat(LOCALE, { style: 'currency', currency: total.currency }).format(Number(total.amount)); }
    catch (e) { return total.amount + ' ' + total.currency; }
  }
  var mem = {};
  function sget(k) { try { return window.sessionStorage.getItem('cwu:' + k); } catch (e) { return mem[k] || null; } }
  function sset(k, v) { try { window.sessionStorage.setItem('cwu:' + k, v); } catch (e) { mem[k] = v; } }

  function request(path, opts) {
    opts = opts || {};
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 20000) : null;
    return fetch(PROXY + path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
      signal: ctrl ? ctrl.signal : undefined,
    }).then(function (res) {
      if (timer) clearTimeout(timer);
      return res.json().catch(function () { return null; }).then(function (data) {
        return { status: res.status, data: data || { ok: false, error: 'bad_response' } };
      });
    }, function () {
      if (timer) clearTimeout(timer);
      return { status: 0, data: { ok: false, error: 'network' } };
    });
  }

  var ICON = {
    chat: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4 6.5A3.5 3.5 0 0 1 7.5 3h9A3.5 3.5 0 0 1 20 6.5v7a3.5 3.5 0 0 1-3.5 3.5H11l-4.3 3.4c-.66.52-1.7.05-1.7-.8V17A3.5 3.5 0 0 1 4 13.5z"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
    chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>',
    box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 7.5L12 3l8.5 4.5v9L12 21l-8.5-4.5z"/><path d="M3.5 7.5L12 12l8.5-4.5M12 12v9"/></svg>',
    ret: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6L5 10l4 4"/><path d="M5 10h9.5a4.5 4.5 0 0 1 0 9H12"/></svg>',
    spark: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.5l1.9 5.2 5.1 1.8-5.1 1.9L12 16.6l-1.9-5.2L5 9.5l5.1-1.8zM18.5 15l.9 2.5 2.5.9-2.5.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9z"/></svg>',
    truck: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 6h11v10h-11zM13.5 9.5h4l3 3.5v3h-7z"/><circle cx="6.5" cy="17.5" r="1.8" fill="#fff"/><circle cx="17" cy="17.5" r="1.8" fill="#fff"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6.5A2.5 2.5 0 0 0 13.5 4h-7A2.5 2.5 0 0 0 4 6.5v7A2.5 2.5 0 0 0 6.5 16H8"/></svg>',
    ext: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/></svg>',
    alert: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zm-1-14.5a1 1 0 1 1 2 0v5.5a1 1 0 1 1-2 0zM12 17.8a1.3 1.3 0 1 0 0-2.6 1.3 1.3 0 0 0 0 2.6z"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  };

  // ------------------------------------------------------------------ styles (scoped to the shadow root)
  var CSS = [
    ':host{all:initial;position:fixed;z-index:2147483000;bottom:0;font-family:var(--cwu-font);-webkit-font-smoothing:antialiased;color:#1a1a1a;font-size:14px;line-height:1.45}',
    ':host([data-side=right]){right:0}:host([data-side=left]){left:0}',
    '#w{font-family:var(--cwu-font);font-size:14px;line-height:1.45;font-weight:400;font-style:normal;letter-spacing:normal;word-spacing:normal;text-transform:none;text-align:left;text-indent:0;text-shadow:none;white-space:normal;color:#1a1a1a;direction:ltr}',
    '*,*::before,*::after{box-sizing:border-box;letter-spacing:inherit}',
    'button,input{font:inherit;color:inherit}',
    'button{cursor:pointer}',
    '.launcher{position:fixed;bottom:20px;width:58px;height:58px;border-radius:50%;border:0;background:var(--accent);color:var(--on-accent);display:grid;place-items:center;box-shadow:0 8px 24px -6px rgba(0,0,0,.35),0 2px 6px rgba(0,0,0,.12);transition:transform .2s cubic-bezier(.2,.8,.3,1.2),box-shadow .2s}',
    ':host([data-side=right]) .launcher{right:20px}:host([data-side=left]) .launcher{left:20px}',
    '.launcher:hover{transform:scale(1.06)}.launcher:active{transform:scale(.96)}',
    '.launcher:focus-visible,.btn:focus-visible,.row:focus-visible,.icon-btn:focus-visible,.link:focus-visible{outline:3px solid var(--accent);outline-offset:3px}',
    '.launcher svg{width:28px;height:28px;position:absolute;transition:transform .25s ease,opacity .2s ease}',
    '.launcher .i-close{opacity:0;transform:rotate(-90deg) scale(.6)}',
    '.open .launcher .i-chat{opacity:0;transform:rotate(90deg) scale(.6)}.open .launcher .i-close{opacity:1;transform:none}',
    '.panel{position:fixed;bottom:92px;width:380px;max-width:calc(100vw - 32px);height:auto;max-height:min(640px,calc(100vh - 116px));background:#fff;border-radius:20px;box-shadow:0 24px 64px -12px rgba(0,0,0,.32),0 0 0 1px rgba(0,0,0,.06);display:flex;flex-direction:column;overflow:hidden;opacity:0;transform:translateY(16px) scale(.98);transform-origin:bottom right;pointer-events:none;visibility:hidden;transition:opacity .2s ease,transform .25s cubic-bezier(.2,.8,.3,1),visibility 0s linear .25s}',
    ':host([data-side=right]) .panel{right:20px}:host([data-side=left]) .panel{left:20px;transform-origin:bottom left}',
    '.open .panel{opacity:1;transform:none;pointer-events:auto;visibility:visible;transition:opacity .2s ease,transform .25s cubic-bezier(.2,.8,.3,1),visibility 0s}',
    '@media (max-width:560px){:host([data-side]) .panel{inset:0;left:0;right:0;top:0;bottom:0;width:100%;max-width:none;height:100%;max-height:none;border-radius:0}.body{flex:1 1 auto}.open .launcher{opacity:0;pointer-events:none}.launcher{bottom:16px}:host([data-side=right]) .launcher{right:16px}:host([data-side=left]) .launcher{left:16px}}',
    /* header */
    '.head{background:var(--brand);color:var(--on-brand);padding:18px 18px 26px;position:relative;flex-shrink:0}',
    '.head--compact{padding:12px 12px 14px;display:flex;align-items:center;gap:6px}',
    '.head__row{display:flex;align-items:center;gap:10px}',
    '.logo{width:36px;height:36px;border-radius:10px;background:rgba(255,255,255,.18);display:grid;place-items:center;font-weight:700;font-size:16px;flex-shrink:0;overflow:hidden}',
    '.logo img{width:100%;height:100%;object-fit:contain;background:#fff}',
    '.shop{font-weight:650;font-size:15px;line-height:1.2}',
    '.sub{font-size:12px;opacity:.82;display:flex;align-items:center;gap:6px;margin-top:2px}',
    '.dot{width:7px;height:7px;border-radius:50%;background:#35d07f;box-shadow:0 0 0 2px rgba(53,208,127,.25)}',
    '.greet{font-size:22px;font-weight:700;line-height:1.22;letter-spacing:-.3px;margin:18px 0 0;overflow-wrap:anywhere}',
    '.icon-btn{border:0;background:transparent;color:inherit;width:36px;height:36px;border-radius:10px;display:grid;place-items:center;flex-shrink:0}',
    '.icon-btn:hover{background:rgba(127,127,127,.18)}.icon-btn svg{width:20px;height:20px}',
    '.head__close{position:absolute;top:12px;right:12px}',
    '.title{font-weight:650;font-size:16px;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    /* body */
    '.body{flex:1 1 auto;min-height:0;overflow-y:auto;background:#f6f6f7;padding:14px;display:flex;flex-direction:column;gap:10px;overscroll-behavior:contain}',
    '.body>*{flex-shrink:0}',
    '.body--lift{margin-top:-12px;border-radius:16px 16px 0 0;position:relative}',
    '.card{background:#fff;border-radius:14px;box-shadow:0 0 0 1px rgba(0,0,0,.06),0 1px 2px rgba(0,0,0,.04);padding:14px}',
    '.row{display:flex;align-items:center;gap:12px;width:100%;text-align:left;border:0;background:#fff;border-radius:14px;padding:13px 14px;box-shadow:0 0 0 1px rgba(0,0,0,.06),0 1px 2px rgba(0,0,0,.04);transition:box-shadow .15s,transform .1s}',
    '.row:hover{box-shadow:0 0 0 1px rgba(0,0,0,.1),0 4px 12px -4px rgba(0,0,0,.12)}.row:active{transform:scale(.99)}',
    '.row__icon{width:38px;height:38px;border-radius:11px;display:grid;place-items:center;flex-shrink:0;background:var(--accent-soft);color:var(--accent-ink)}',
    '.row__icon svg{width:20px;height:20px}',
    '.row__text{flex:1;min-width:0}.row__title{font-weight:650;display:block}.row__sub{display:block;font-size:12.5px;color:#6b6b6b;margin-top:1px}',
    '.row__chev{width:18px;height:18px;color:#b3b3b3;flex-shrink:0}',
    '.foot{text-align:center;font-size:11px;color:#9b9b9b;padding:10px 0 12px;background:#f6f6f7;flex-shrink:0}',
    '.foot b{font-weight:600;color:#7b7b7b}',
    /* forms */
    'label{display:block;font-weight:600;font-size:13px;margin:0 0 6px}',
    '.field+.field{margin-top:14px}',
    'input{width:100%;height:46px;border-radius:12px;border:1.5px solid #d4d4d8;background:#fff;padding:0 14px;font-size:16px;outline:none;transition:border-color .15s,box-shadow .15s}',
    'input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}',
    'input[aria-invalid=true]{border-color:#d72c0d;background:#fff8f7}',
    '.err{color:#b42318;font-size:12.5px;margin-top:6px;display:flex;gap:6px;align-items:flex-start}',
    '.hint{color:#6b6b6b;font-size:12.5px;margin-top:6px}',
    '.btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;height:48px;border:0;border-radius:12px;background:var(--accent);color:var(--on-accent);font-weight:650;font-size:15px;margin-top:16px;transition:filter .15s,transform .1s;text-decoration:none}',
    '.btn:hover{filter:brightness(1.06)}.btn:active{transform:scale(.99)}.btn[disabled]{opacity:.65;cursor:progress}',
    '.btn--ghost{background:#fff;color:#1a1a1a;box-shadow:inset 0 0 0 1.5px #d4d4d8;margin-top:10px}',
    '.btn svg{width:18px;height:18px}',
    '.spin{width:18px;height:18px;border:2.5px solid currentColor;border-right-color:transparent;border-radius:50%;animation:cwu-spin .7s linear infinite}',
    '@keyframes cwu-spin{to{transform:rotate(360deg)}}',
    '.alert{display:flex;gap:10px;align-items:flex-start;background:#fff4f2;color:#8e1f0b;border-radius:12px;padding:12px;font-size:13.5px;box-shadow:inset 0 0 0 1px rgba(215,44,13,.18)}',
    '.alert svg{width:18px;height:18px;flex-shrink:0;margin-top:1px}',
    '.alert--info{background:#f1f5ff;color:#1e3a8a;box-shadow:inset 0 0 0 1px rgba(30,58,138,.14)}',
    '.section-title{font-size:12px;font-weight:650;text-transform:uppercase;letter-spacing:.06em;color:#7a7a7a;margin:6px 2px 0}',
    /* status */
    '.status__label{font-size:12px;font-weight:650;color:var(--accent-ink);text-transform:uppercase;letter-spacing:.06em}',
    '.status__head{font-size:21px;font-weight:750;letter-spacing:-.3px;line-height:1.2;margin-top:4px}',
    '.status__detail{color:#555;margin-top:4px}',
    '.status--bad .status__label{color:#b42318}',
    '.steps{display:grid;grid-template-columns:repeat(4,1fr);margin-top:18px;position:relative}',
    '.steps__track{position:absolute;top:10px;left:12.5%;right:12.5%;height:4px;border-radius:4px;background:#e7e7ea}',
    '.steps__fill{position:absolute;top:10px;left:12.5%;height:4px;border-radius:4px;background:var(--accent-ink);transition:width .6s cubic-bezier(.2,.8,.3,1)}',
    '.step{display:flex;flex-direction:column;align-items:center;gap:6px;position:relative;text-align:center}',
    '.step__dot{width:24px;height:24px;border-radius:50%;background:#fff;box-shadow:inset 0 0 0 3px #e0e0e4;display:grid;place-items:center;color:var(--on-ink)}',
    '.step__dot svg{width:13px;height:13px}',
    '.step--done .step__dot{background:var(--accent-ink);box-shadow:none}',
    '.step--now .step__dot{background:var(--accent-ink);box-shadow:0 0 0 5px var(--accent-soft)}',
    '.step__label{font-size:11.5px;color:#8a8a8a;font-weight:550;line-height:1.2}',
    '.step--done .step__label,.step--now .step__label{color:#1a1a1a}',
    '.ship{display:flex;flex-direction:column;gap:10px}',
    '.ship__top{display:flex;align-items:center;gap:10px}',
    '.ship__icon{width:34px;height:34px;border-radius:10px;background:var(--accent-soft);color:var(--accent-ink);display:grid;place-items:center;flex-shrink:0}.ship__icon svg{width:18px;height:18px}',
    '.pill{display:inline-flex;align-items:center;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:600;background:#eef0f3;color:#3a3a3a}',
    '.pill--ok{background:#dcfce7;color:#14532d}.pill--bad{background:#fee4e2;color:#912018}',
    '.track-no{display:flex;align-items:center;gap:8px;background:#f6f6f7;border-radius:10px;padding:8px 10px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}',
    '.track-no span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.track-no button{border:0;background:transparent;display:grid;place-items:center;width:28px;height:28px;border-radius:8px;color:#555}.track-no button:hover{background:#e9e9ec}.track-no svg{width:16px;height:16px}',
    '.items{display:flex;flex-direction:column;gap:10px}',
    '.item{display:flex;align-items:center;gap:12px}',
    '.item__img{width:48px;height:48px;border-radius:10px;background:#f1f1f3 center/cover no-repeat;flex-shrink:0;position:relative;box-shadow:inset 0 0 0 1px rgba(0,0,0,.05)}',
    '.item__qty{position:absolute;top:-6px;right:-6px;min-width:20px;height:20px;border-radius:10px;background:#555;color:#fff;font-size:11px;font-weight:700;display:grid;place-items:center;padding:0 5px}',
    '.item__t{font-weight:600;font-size:13.5px;line-height:1.3}.item__v{font-size:12.5px;color:#6b6b6b}',
    '.meta{display:flex;justify-content:space-between;color:#6b6b6b;font-size:12.5px;margin-top:2px}',
    '.link{display:inline-flex;align-items:center;gap:6px;color:var(--accent-ink);font-weight:600;text-decoration:none;font-size:13.5px}.link svg{width:15px;height:15px}.link:hover{text-decoration:underline}',
    '.order-row .row__icon{background:#f1f1f3 center/cover no-repeat}',
    '.skel{height:66px;border-radius:14px;background:linear-gradient(90deg,#ececef,#f6f6f7,#ececef);background-size:200% 100%;animation:cwu-sh 1.2s infinite}',
    '@keyframes cwu-sh{from{background-position:100% 0}to{background-position:-100% 0}}',
    '.view{animation:cwu-in .22s ease}@keyframes cwu-in{from{opacity:0;transform:translateX(8px)}to{opacity:1;transform:none}}',
    '.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}',
    '@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}',
  ].join('');

  // ------------------------------------------------------------------ config
  function readInlineConfig() {
    var el = document.getElementById('chatwithuss-config');
    if (!el) return null;
    try {
      var c = JSON.parse(el.textContent || 'null');
      return c && typeof c === 'object' && c.brand_color ? c : null;
    } catch (e) { return null; }
  }

  function loadConfig() {
    var inline = readInlineConfig();
    if (inline) return Promise.resolve(inline);
    return request('/config').then(function (r) { return r.data && r.data.ok ? r.data.config : null; });
  }

  // ------------------------------------------------------------------ state
  var S = {
    open: false,
    view: 'home',
    busy: false,
    errors: {},
    alert: null,
    order: null,
    orders: null,
    ordersFailed: false,
    form: { order: sget('order') || '', email: sget('email') || '' },
  };
  var C = null;
  var host, shadow, wrap, panel, launcher, lastFocus;

  function setState(patch) {
    for (var k in patch) S[k] = patch[k];
    render();
  }

  // ------------------------------------------------------------------ views
  function header(title) {
    if (!title) {
      var logo = C.logo_url
        ? '<span class="logo"><img src="' + safeUrl(C.logo_url) + '" alt="" loading="lazy"></span>'
        : '<span class="logo" aria-hidden="true">' + esc((C.shop_name || ds.shopName || 'S').charAt(0).toUpperCase()) + '</span>';
      return '<div class="head">' +
        '<button class="icon-btn head__close" data-act="close" aria-label="Close chat">' + ICON.close + '</button>' +
        '<div class="head__row">' + logo + '<div><div class="shop">' + esc(C.shop_name || ds.shopName || '') + '</div>' +
        '<div class="sub"><span class="dot"></span>' + ((C.features || {}).ai ? 'Instant answers, 24/7' : 'Order help, anytime') + '</div></div></div>' +
        '<h2 class="greet">' + esc(C.greeting) + '</h2></div>';
    }
    return '<div class="head head--compact">' +
      '<button class="icon-btn" data-act="back" aria-label="Back">' + ICON.back + '</button>' +
      '<div class="title">' + esc(title) + '</div>' +
      '<button class="icon-btn" data-act="close" aria-label="Close chat">' + ICON.close + '</button></div>';
  }

  function row(act, icon, title, sub, extraClass, style) {
    return '<button class="row ' + (extraClass || '') + '" data-act="' + esc(act) + '">' +
      '<span class="row__icon"' + (style ? ' style="' + style + '"' : '') + '>' + (icon || '') + '</span>' +
      '<span class="row__text"><span class="row__title">' + esc(title) + '</span>' + (sub ? '<span class="row__sub">' + esc(sub) + '</span>' : '') + '</span>' +
      '<span class="row__chev">' + ICON.chev + '</span></button>';
  }

  function homeView() {
    var f = C.features || {};
    var rows = [row('track', ICON.box, 'Track my order', 'Live delivery status')];
    if (f.returns) rows.push(row('returns', ICON.ret, 'Start a return', 'Within ' + (C.return_window_days || 30) + ' days of delivery'));
    if (f.ai) rows.push(row('ask', ICON.spark, 'Ask a question', 'Shipping, sizing, policies'));
    if (rows.length === 1 && !LOGGED_IN) {
      var alert = S.alert ? '<div class="alert" role="alert">' + ICON.alert + '<div>' + esc(S.alert) + '</div></div>' : '';
      return header() + '<div class="body body--lift view"><div class="section-title">Where\u2019s my order?</div>' + alert + trackForm(true) + '</div>';
    }
    return header() + '<div class="body body--lift view">' + rows.join('') + '</div>';
  }

  function fieldErr(k) {
    return S.errors[k] ? '<div class="err" id="err-' + k + '">' + esc(S.errors[k]) + '</div>' : '';
  }

  function trackForm(autofocus) {
    return '<form class="card" novalidate data-form="track">' +
        '<div class="field"><label for="cwu-order">Order number</label>' +
        '<input id="cwu-order" name="order" inputmode="text" autocomplete="off" autocapitalize="characters" placeholder="e.g. #1001" value="' + esc(S.form.order) + '"' +
        (S.errors.order ? ' aria-invalid="true" aria-describedby="err-order"' : '') + (autofocus ? ' data-autofocus' : '') + '>' + fieldErr('order') +
        '<div class="hint">It\u2019s in your order confirmation email.</div></div>' +
        (LOGGED_IN ? '' :
          '<div class="field"><label for="cwu-email">Email used at checkout</label>' +
          '<input id="cwu-email" name="email" type="email" inputmode="email" autocomplete="email" placeholder="you@example.com" value="' + esc(S.form.email) + '"' +
          (S.errors.email ? ' aria-invalid="true" aria-describedby="err-email"' : '') + '>' + fieldErr('email') + '</div>') +
        '<button class="btn" type="submit"' + (S.busy ? ' disabled' : '') + '>' + (S.busy ? '<span class="spin"></span>Finding your order\u2026' : 'Track order') + '</button>' +
      '</form>';
  }

  function trackView() {
    var parts = [];
    if (S.alert) parts.push('<div class="alert" role="alert">' + ICON.alert + '<div>' + esc(S.alert) + '</div></div>');

    if (LOGGED_IN) {
      parts.push('<div class="section-title">Your recent orders</div>');
      if (S.orders === null && !S.ordersFailed) parts.push('<div class="skel"></div><div class="skel"></div>');
      else if (S.orders && S.orders.length) {
        S.orders.forEach(function (o) {
          var sub = (o.cancelled ? 'Cancelled' : o.headline) + ' \u00b7 ' + fmtDate(o.placed_at, true);
          parts.push(row('open-order:' + o.name, o.image ? '' : ICON.box, o.name, sub, 'order-row', o.image ? "background-image:url('" + safeUrl(o.image) + "')" : ''));
        });
      } else if (S.orders) parts.push('<div class="card hint" style="margin:0">No orders on your account yet.</div>');
      parts.push('<div class="section-title" style="margin-top:10px">Track another order</div>');
    }

    parts.push(trackForm(true));
    return header('Track your order') + '<div class="body view">' + parts.join('') + '</div>';
  }

  function stepsHtml(o) {
    var pct = [0, 33.333, 66.666, 100][Math.max(0, Math.min(3, o.stage))];
    var html = '<div class="steps" aria-hidden="true"><div class="steps__track"></div><div class="steps__fill" style="width:' + (pct * 0.75) + '%"></div>';
    o.stages.forEach(function (label, i) {
      var cls = i < o.stage ? 'step--done' : i === o.stage ? 'step--now' : '';
      html += '<div class="step ' + cls + '"><span class="step__dot">' + (i < o.stage || (i === o.stage && o.stage === 3) ? ICON.check : '') + '</span><span class="step__label">' + esc(label) + '</span></div>';
    });
    return html + '</div>';
  }

  function resultView() {
    var o = S.order;
    var bad = o.cancelled || o.shipments.some(function (s) { return s.issue; });
    var sub = '';
    if (o.cancelled) sub = o.detail;
    else if (o.delivered_at) sub = 'on ' + fmtDate(o.delivered_at);
    else if (o.eta) sub = 'Arriving by ' + fmtDate(o.eta) + (o.detail ? ' \u00b7 ' + o.detail : '');
    else if (o.detail) sub = o.detail;

    var parts = [];
    parts.push(
      '<div class="card' + (bad ? ' status--bad' : '') + '">' +
        '<div class="status__label">' + esc(o.cancelled ? 'Cancelled' : o.stages[o.stage]) + '</div>' +
        '<div class="status__head">' + esc(o.headline) + '</div>' +
        (sub ? '<div class="status__detail">' + esc(sub) + '</div>' : '') +
        (o.cancelled ? '' : stepsHtml(o)) +
      '</div>'
    );
    if (o.partial) parts.push('<div class="alert alert--info">' + ICON.box + '<div>Some items ship separately. Each package is listed below.</div></div>');

    o.shipments.forEach(function (s, i) {
      var pillCls = s.issue ? 'pill--bad' : s.stage === 3 ? 'pill--ok' : '';
      var when = s.delivered_at ? 'Delivered ' + fmtDate(s.delivered_at) : s.estimated_delivery_at ? 'Est. ' + fmtDate(s.estimated_delivery_at) : s.shipped_at ? 'Shipped ' + fmtDate(s.shipped_at) : '';
      parts.push(
        '<div class="card ship">' +
          '<div class="ship__top"><span class="ship__icon">' + ICON.truck + '</span><div style="flex:1;min-width:0">' +
            '<div style="font-weight:650">' + esc(o.shipments.length > 1 ? 'Package ' + (i + 1) : 'Shipment') + (s.carrier ? ' \u00b7 ' + esc(s.carrier) : '') + '</div>' +
            '<div class="meta"><span>' + esc(when) + '</span>' + (s.item_count ? '<span>' + s.item_count + (s.item_count === 1 ? ' item' : ' items') + '</span>' : '') + '</div>' +
          '</div><span class="pill ' + pillCls + '">' + esc(s.label) + '</span></div>' +
          (s.tracking_number ? '<div class="track-no"><span>' + esc(s.tracking_number) + '</span><button type="button" data-copy="' + esc(s.tracking_number) + '" aria-label="Copy tracking number">' + ICON.copy + '</button></div>' : '') +
          (s.tracking_url ? '<a class="link" href="' + safeUrl(s.tracking_url) + '" target="_blank" rel="noopener noreferrer">Track with ' + esc(s.carrier || 'carrier') + ICON.ext + '</a>' : '') +
        '</div>'
      );
    });

    if (o.items.length) {
      parts.push('<div class="card"><div class="items">' + o.items.map(function (it) {
        return '<div class="item"><span class="item__img"' + (it.image ? " style=\"background-image:url('" + safeUrl(it.image) + "')\"" : '') + '>' +
          (it.quantity > 1 ? '<span class="item__qty">' + it.quantity + '</span>' : '') + '</span>' +
          '<div style="min-width:0"><div class="item__t">' + esc(it.title) + '</div>' + (it.variant ? '<div class="item__v">' + esc(it.variant) + '</div>' : '') + '</div></div>';
      }).join('') + '</div>' +
      '<div class="meta" style="margin-top:12px;padding-top:10px;border-top:1px solid #eee"><span>Placed ' + esc(fmtDate(o.placed_at, true)) + '</span><span style="font-weight:650;color:#1a1a1a">' + esc(fmtMoney(o.total)) + '</span></div></div>');
    }

    if (o.status_page_url) parts.push('<a class="btn btn--ghost" href="' + safeUrl(o.status_page_url) + '" target="_blank" rel="noopener noreferrer">View full order details' + ICON.ext + '</a>');
    parts.push('<button class="btn btn--ghost" data-act="track-another" style="margin-top:0">Track another order</button>');

    return header('Order ' + o.name) + '<div class="body view">' + parts.join('') + '</div>';
  }

  function render() {
    if (!panel) return;
    var html = S.view === 'result' && S.order ? resultView() : S.view === 'track' ? trackView() : homeView();
    panel.innerHTML = html + '<div class="foot">Powered by <b>ChatWithUss</b></div>';
    wrap.className = S.open ? 'open' : '';
    launcher.setAttribute('aria-expanded', String(S.open));
    launcher.setAttribute('aria-label', S.open ? 'Close chat' : 'Open chat, get help with your order');
    if (S.open) {
      var af = panel.querySelector('[aria-invalid=true]') || panel.querySelector('[data-autofocus]');
      if (af && !MOBILE_Q.matches && shadow.activeElement == null) af.focus({ preventScroll: true });
    }
  }

  // ------------------------------------------------------------------ actions
  var scrollLock = null;
  function lockScroll(on) {
    var el = document.documentElement;
    if (on && MOBILE_Q.matches && scrollLock === null) { scrollLock = el.style.overflow; el.style.overflow = 'hidden'; }
    else if (!on && scrollLock !== null) { el.style.overflow = scrollLock; scrollLock = null; }
  }

  function open(view) {
    if (!C) return;
    lastFocus = document.activeElement;
    S.open = true;
    if (view) go(view); else render();
    lockScroll(true);
    var first = panel.querySelector('[data-autofocus]') || panel.querySelector('button');
    if (first && !MOBILE_Q.matches) setTimeout(function () { first.focus({ preventScroll: true }); }, 60);
  }

  function close() {
    S.open = false;
    render();
    lockScroll(false);
    try { if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true }); else launcher.focus(); } catch (e) {}
  }

  function go(view) {
    S.alert = null;
    S.errors = {};
    S.view = view;
    render();
    panel.querySelector('.body') && (panel.querySelector('.body').scrollTop = 0);
    if (view === 'track' && LOGGED_IN && S.orders === null) loadOrders();
    if (S.open && !MOBILE_Q.matches) {
      var f = panel.querySelector('[data-autofocus]') || panel.querySelector('.icon-btn');
      if (f) f.focus({ preventScroll: true });
    }
  }

  function loadOrders() {
    request('/orders').then(function (r) {
      if (r.data && r.data.ok) setState({ orders: r.data.orders });
      else setState({ orders: [], ordersFailed: true });
    });
  }

  function track(orderNumber, email) {
    var errors = {};
    if (!orderNumber || !orderNumber.trim()) errors.order = 'Enter your order number, e.g. #1001';
    if (!LOGGED_IN && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test((email || '').trim())) errors.email = 'Enter the email you used at checkout';
    if (Object.keys(errors).length) return setState({ errors: errors, alert: null });

    S.form.order = orderNumber.trim();
    S.form.email = (email || '').trim();
    sset('order', S.form.order);
    if (S.form.email) sset('email', S.form.email);
    setState({ busy: true, errors: {}, alert: null });

    var body = { order: S.form.order };
    if (S.form.email) body.email = S.form.email;
    request('/track', { method: 'POST', body: body }).then(function (r) {
      var d = r.data || {};
      if (d.ok && d.order) {
        S.busy = false;
        S.from = S.view === 'track' ? 'track' : 'home';
        S.order = d.order;
        go('result');
        return;
      }
      var alert = d.message || (r.status === 0 ? 'You seem to be offline. Check your connection and try again.' : 'Something went wrong. Please try again.');
      setState({ busy: false, errors: d.errors || {}, alert: d.errors ? null : alert });
    });
  }

  function onClick(e) {
    var t = e.target.closest ? e.target.closest('[data-act],[data-copy]') : null;
    if (!t) return;
    if (t.hasAttribute('data-copy')) {
      var v = t.getAttribute('data-copy');
      (navigator.clipboard ? navigator.clipboard.writeText(v) : Promise.reject()).then(function () {
        t.innerHTML = ICON.check;
        setTimeout(function () { t.innerHTML = ICON.copy; }, 1500);
      }, function () {});
      return;
    }
    var act = t.getAttribute('data-act');
    if (act === 'close') close();
    else if (act === 'back') go(S.view === 'result' && S.from === 'track' ? 'track' : 'home');
    else if (act === 'track') go('track');
    else if (act === 'track-another') { S.form.order = ''; S.order = null; go(S.from === 'track' ? 'track' : 'home'); }
    else if (act.indexOf('open-order:') === 0) track(act.slice(11), null);
  }

  function onSubmit(e) {
    var form = e.target;
    if (!form || form.getAttribute('data-form') !== 'track') return;
    e.preventDefault();
    var o = form.querySelector('[name=order]');
    var em = form.querySelector('[name=email]');
    track(o ? o.value : '', em ? em.value : '');
  }

  function onInput(e) {
    var n = e.target && e.target.name;
    if (n === 'order' || n === 'email') {
      S.form[n] = e.target.value;
      if (S.errors[n]) {
        delete S.errors[n];
        e.target.removeAttribute('aria-invalid');
        var er = panel.querySelector('#err-' + n);
        if (er) er.remove();
      }
    }
  }

  // ------------------------------------------------------------------ mount
  function mount(cfg) {
    C = cfg;
    var brand = hex(cfg.brand_color, '#111111');
    var accent = hex(cfg.accent_color, '#4F46E5');
    var onAccent = onColor(accent);
    var accentInk = inkOnWhite(accent);

    host = document.createElement('div');
    host.id = 'chatwithuss-widget';
    host.setAttribute('data-side', cfg.position === 'left' ? 'left' : 'right');
    var font = '';
    try { font = window.getComputedStyle(document.body).fontFamily; } catch (e) {}
    host.style.setProperty('--cwu-font', font || '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif');
    document.body.appendChild(host);

    shadow = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    shadow.innerHTML =
      '<style>' + CSS + '</style>' +
      '<div id="w" style="--brand:' + brand + ';--on-brand:' + onColor(brand) + ';--accent:' + accent + ';--on-accent:' + onAccent + ';--accent-ink:' + accentInk + ';--on-ink:' + onColor(accentInk) + ';--accent-soft:' + accentInk + '1f">' +
        '<div class="panel" role="dialog" aria-modal="false" aria-label="Customer support"></div>' +
        '<button class="launcher" aria-expanded="false" aria-label="Open chat, get help with your order">' +
          ICON.chat.replace('<svg ', '<svg class="i-chat" ') + ICON.close.replace('<svg ', '<svg class="i-close" ') +
        '</button>' +
      '</div>';
    wrap = shadow.getElementById ? shadow.getElementById('w') : shadow.querySelector('#w');
    panel = wrap.querySelector('.panel');
    launcher = wrap.querySelector('.launcher');

    launcher.addEventListener('click', function () { S.open ? close() : open(); });
    panel.addEventListener('click', onClick);
    panel.addEventListener('submit', onSubmit);
    panel.addEventListener('input', onInput);
    wrap.addEventListener('keydown', function (e) { if (e.key === 'Escape' && S.open) { e.stopPropagation(); close(); } });

    render();

    // Deep links merchants can put in menus/emails: /#track-order or /#chatwithuss
    function fromHash() {
      var h = (location.hash || '').toLowerCase();
      if (h === '#track-order' || h === '#chatwithuss-track') open('track');
      else if (h === '#chatwithuss') open();
    }
    fromHash();
    window.addEventListener('hashchange', fromHash);

    window.ChatWithUss = {
      open: function (view) { open(view === 'track' ? 'track' : undefined); },
      close: close,
      track: function (orderNumber) { open('track'); if (orderNumber) { S.form.order = String(orderNumber); render(); } },
    };
  }

  function start() {
    loadConfig().then(function (cfg) {
      if (cfg) mount(cfg);
    }, function () {});
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
