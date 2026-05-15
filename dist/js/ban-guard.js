// Ban guard — runs early on every page.
// If the user is banned, redirects to the ban error page with case details.
// Also intercepts fetch() so any 403 isBanned response from /api/* triggers redirect.
(function () {
  'use strict';

  var BAN_PAGE = '/errors/ban-access-denied.html';
  if (location.pathname === BAN_PAGE) return; // already on ban page

  function buildBanUrl(d) {
    var qs = new URLSearchParams();
    if (d && d.caseId) qs.set('caseId', d.caseId);
    if (d && d.appealDeadline) qs.set('deadline', d.appealDeadline);
    var s = qs.toString();
    return BAN_PAGE + (s ? '?' + s : '');
  }

  function goBan(d) {
    try { sessionStorage.setItem('ss_banned', '1'); } catch (_) {}
    location.replace(buildBanUrl(d));
  }

  // Telegram headers
  function tgHeaders() {
    var h = { 'Content-Type': 'application/json' };
    try {
      var wa = window.Telegram && window.Telegram.WebApp;
      if (wa && wa.initData) h['x-telegram-init-data'] = wa.initData;
      var uid = wa && wa.initDataUnsafe && wa.initDataUnsafe.user && wa.initDataUnsafe.user.id;
      if (uid) h['x-telegram-id'] = String(uid);
    } catch (_) {}
    return h;
  }

  // Intercept fetch responses — any /api/* 403 with isBanned=true sends user to ban page
  var origFetch = window.fetch ? window.fetch.bind(window) : null;
  if (origFetch) {
    window.fetch = function (input, init) {
      return origFetch(input, init).then(function (res) {
        try {
          if (res && res.status === 403) {
            var url = typeof input === 'string' ? input : (input && input.url) || '';
            if (url.indexOf('/api/') !== -1) {
              var clone = res.clone();
              clone.json().then(function (body) {
                if (body && body.isBanned) goBan(body);
              }).catch(function () {});
            }
          }
        } catch (_) {}
        return res;
      });
    };
  }

  // Probe whoami early
  function probe() {
    try {
      fetch('/api/whoami', { headers: tgHeaders(), cache: 'no-store' })
        .then(function (r) { return r.json().catch(function () { return {}; }); })
        .then(function (data) {
          if (data && data.isBanned) goBan(data);
        })
        .catch(function () {});
    } catch (_) {}
  }

  if (window.Telegram && window.Telegram.WebApp) {
    try { window.Telegram.WebApp.ready(); } catch (_) {}
    probe();
  } else {
    // Wait briefly for Telegram script
    var tries = 0;
    var iv = setInterval(function () {
      tries++;
      if (window.Telegram && window.Telegram.WebApp) {
        clearInterval(iv);
        probe();
      } else if (tries > 20) {
        clearInterval(iv);
        probe(); // probe anyway; server will see no id and ignore
      }
    }, 100);
  }
})();
