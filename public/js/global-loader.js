
// Global page loading overlay - auto-injects on every page load.
//
// Two modes:
//  1. Default (legacy): full-page overlay until window 'load'. Used by pages
//     that haven't been refactored for partial-loading yet.
//  2. Fast mode: opt-in via <body data-fast-load="1">. Skips the full-page
//     overlay entirely so pre-rendered HTML paints immediately. Pages then
//     show small skeleton placeholders (see window.Skeleton) only in the
//     specific regions that fetch data. This avoids the long blank loading
//     screen on app pages.
(function () {
  if (window.__globalLoaderInstalled) return;
  window.__globalLoaderInstalled = true;

  var STYLE_ID = 'global-loader-styles';
  var OVERLAY_ID = 'global-loader-overlay';
  var MIN_VISIBLE_MS = 250;   // avoid flash
  var MAX_VISIBLE_MS = 8000;  // safety: never block UI forever
  var shownAt = Date.now();

  function isFastLoad() {
    try {
      var b = document.body || document.documentElement;
      if (b && b.dataset && (b.dataset.fastLoad === '1' || b.dataset.fastLoad === 'true')) return true;
      if (b && b.getAttribute && b.getAttribute('data-fast-load')) return true;
    } catch (_) {}
    return false;
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      '#' + OVERLAY_ID + '{',
      '  position:fixed;inset:0;z-index:2147483646;',
      '  display:flex;flex-direction:column;align-items:center;justify-content:center;',
      '  background:#ffffff;color:#333;',
      '  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;',
      '  transition:opacity .3s ease;opacity:1;',
      '}',
      '#' + OVERLAY_ID + '.is-hiding{opacity:0;pointer-events:none;}',
      '#' + OVERLAY_ID + ' .gl-spinner{',
      '  width:40px;height:40px;border-radius:50%;',
      '  border:4px solid rgba(0,0,0,.1);border-top-color:#007bff;',
      '  animation:gl-spin 1s linear infinite;',
      '}',
      '#' + OVERLAY_ID + ' .gl-text{margin-top:14px;font-size:15px;color:#444;}',
      '@keyframes gl-spin{to{transform:rotate(360deg);}}',
      /* Inline skeleton placeholders for fast-load pages */
      '.sk-shimmer{position:relative;overflow:hidden;background:rgba(0,0,0,.06);border-radius:8px;}',
      '.sk-shimmer::after{content:"";position:absolute;inset:0;transform:translateX(-100%);',
      '  background:linear-gradient(90deg,transparent,rgba(255,255,255,.55),transparent);',
      '  animation:sk-shimmer 1.2s infinite;}',
      '@keyframes sk-shimmer{100%{transform:translateX(100%);}}',
      '.sk-line{height:12px;margin:6px 0;}',
      '.sk-block{height:80px;}',
      '.sk-circle{width:40px;height:40px;border-radius:50%;}',
      '@media (prefers-color-scheme: dark){',
      '  #' + OVERLAY_ID + '{background:#0f1115;color:#eee;}',
      '  #' + OVERLAY_ID + ' .gl-text{color:#ccc;}',
      '  #' + OVERLAY_ID + ' .gl-spinner{border-color:rgba(255,255,255,.15);border-top-color:#4ea3ff;}',
      '  .sk-shimmer{background:rgba(255,255,255,.07);}',
      '  .sk-shimmer::after{background:linear-gradient(90deg,transparent,rgba(255,255,255,.10),transparent);}',
      '}',
      'body[data-theme="dark"] #' + OVERLAY_ID + '{background:#0f1115;color:#eee;}',
      'body[data-theme="dark"] #' + OVERLAY_ID + ' .gl-text{color:#ccc;}',
      'body[data-theme="dark"] #' + OVERLAY_ID + ' .gl-spinner{border-color:rgba(255,255,255,.15);border-top-color:#4ea3ff;}',
      'body[data-theme="dark"] .sk-shimmer{background:rgba(255,255,255,.07);}',
      'body[data-theme="dark"] .sk-shimmer::after{background:linear-gradient(90deg,transparent,rgba(255,255,255,.10),transparent);}'
    ].join('\n');
    (document.head || document.documentElement).appendChild(style);
  }

  function getLoadingText() {
    try {
      if (window.TranslationUtils && typeof TranslationUtils.t === 'function') {
        var t = TranslationUtils.t('loading');
        if (t && t !== 'loading') return t;
      }
    } catch (_) {}
    return 'Loading...';
  }

  function injectOverlay() {
    if (document.getElementById(OVERLAY_ID)) return;
    if (!document.body) {
      var pre = document.createElement('div');
      pre.id = OVERLAY_ID;
      pre.innerHTML = '<div class="gl-spinner"></div><div class="gl-text">' + getLoadingText() + '</div>';
      document.documentElement.appendChild(pre);
      return;
    }
    var overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.setAttribute('role', 'status');
    overlay.setAttribute('aria-live', 'polite');
    overlay.innerHTML = '<div class="gl-spinner"></div><div class="gl-text">' + getLoadingText() + '</div>';
    document.body.appendChild(overlay);
  }

  function hide() {
    var overlay = document.getElementById(OVERLAY_ID);
    if (!overlay) return;
    var elapsed = Date.now() - shownAt;
    var wait = Math.max(0, MIN_VISIBLE_MS - elapsed);
    setTimeout(function () {
      overlay.classList.add('is-hiding');
      setTimeout(function () {
        if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
      }, 320);
    }, wait);
  }

  // Public API
  window.GlobalLoader = {
    show: function () {
      shownAt = Date.now();
      injectStyles();
      if (isFastLoad()) return; // fast pages never get the full overlay
      injectOverlay();
    },
    hide: hide
  };

  // Lightweight skeleton helper for fast-load pages.
  // Usage: Skeleton.render('#balance', '<div class="sk-shimmer sk-line" style="width:60%"></div>');
  //        Skeleton.clear('#balance');
  //        Skeleton.lines('#list', 3);
  window.Skeleton = {
    render: function (sel, html) {
      var el = typeof sel === 'string' ? document.querySelector(sel) : sel;
      if (!el) return;
      el.dataset.skeletonActive = '1';
      el.innerHTML = html;
    },
    lines: function (sel, count, opts) {
      opts = opts || {};
      var widths = opts.widths || ['100%', '85%', '70%'];
      var h = '';
      for (var i = 0; i < (count || 3); i++) {
        var w = widths[i % widths.length];
        h += '<div class="sk-shimmer sk-line" style="width:' + w + '"></div>';
      }
      this.render(sel, h);
    },
    block: function (sel, count) {
      var h = '';
      for (var i = 0; i < (count || 1); i++) h += '<div class="sk-shimmer sk-block" style="margin:8px 0"></div>';
      this.render(sel, h);
    },
    clear: function (sel) {
      var el = typeof sel === 'string' ? document.querySelector(sel) : sel;
      if (!el) return;
      delete el.dataset.skeletonActive;
      el.innerHTML = '';
    }
  };

  injectStyles();

  // Fast-load: skip overlay, just hand off to per-section skeletons.
  if (isFastLoad()) {
    // Re-show overlay only on internal navigation to a non-fast page is fine
    // because that page decides for itself; we just don't draw it here.
    return;
  }

  injectOverlay();

  if (document.readyState === 'complete') {
    hide();
  } else {
    window.addEventListener('load', hide, { once: true });
  }

  setTimeout(hide, MAX_VISIBLE_MS);

  // Re-show on internal navigation
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    var href = a.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
    if (a.target && a.target !== '_self') return;
    if (a.hasAttribute('download')) return;
    try {
      var url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin) return;
    } catch (_) { return; }
    window.GlobalLoader.show();
  }, true);

  document.addEventListener('submit', function () { window.GlobalLoader.show(); }, true);
  window.addEventListener('beforeunload', function () { window.GlobalLoader.show(); });
  window.addEventListener('pageshow', function (e) { if (e.persisted) hide(); });
})();
