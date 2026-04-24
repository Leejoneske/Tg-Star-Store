
// Global page loading overlay - auto-injects on every page load
(function () {
  if (window.__globalLoaderInstalled) return;
  window.__globalLoaderInstalled = true;

  var STYLE_ID = 'global-loader-styles';
  var OVERLAY_ID = 'global-loader-overlay';
  var MIN_VISIBLE_MS = 250;   // avoid flash
  var MAX_VISIBLE_MS = 8000;  // safety: never block UI forever
  var shownAt = Date.now();

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
      '@media (prefers-color-scheme: dark){',
      '  #' + OVERLAY_ID + '{background:#0f1115;color:#eee;}',
      '  #' + OVERLAY_ID + ' .gl-text{color:#ccc;}',
      '  #' + OVERLAY_ID + ' .gl-spinner{border-color:rgba(255,255,255,.15);border-top-color:#4ea3ff;}',
      '}',
      'body[data-theme="dark"] #' + OVERLAY_ID + '{background:#0f1115;color:#eee;}',
      'body[data-theme="dark"] #' + OVERLAY_ID + ' .gl-text{color:#ccc;}',
      'body[data-theme="dark"] #' + OVERLAY_ID + ' .gl-spinner{border-color:rgba(255,255,255,.15);border-top-color:#4ea3ff;}'
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
      // body not ready yet - attach to documentElement temporarily
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

  // Public API for pages that want manual control
  window.GlobalLoader = {
    show: function () {
      shownAt = Date.now();
      injectStyles();
      injectOverlay();
    },
    hide: hide
  };

  injectStyles();
  injectOverlay();

  // Hide once page is fully loaded
  if (document.readyState === 'complete') {
    hide();
  } else {
    window.addEventListener('load', hide, { once: true });
  }

  // Safety net
  setTimeout(hide, MAX_VISIBLE_MS);

  // Re-show on internal navigation (link clicks to same-origin documents)
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

  // Show on form submits
  document.addEventListener('submit', function () {
    window.GlobalLoader.show();
  }, true);

  // Show when navigating away
  window.addEventListener('beforeunload', function () {
    window.GlobalLoader.show();
  });

  // Hide if page is restored from bfcache
  window.addEventListener('pageshow', function (e) {
    if (e.persisted) hide();
  });
})();
