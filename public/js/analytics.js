/**
 * Telegram Mini Apps Analytics SDK loader.
 *
 * Mirrors the official CDN pattern from
 * https://github.com/Telegram-Mini-Apps/analytics:
 *   - load https://tganalytics.xyz/index.js with `async`
 *   - call window.telegramAnalytics.init({ token, appName }) inside onload
 *
 * The SDK must initialize BEFORE the app renders — do NOT defer, do NOT
 * wait for Telegram.WebApp.initData (the SDK reads it itself when sending
 * events), and do NOT block on extra fetches.
 */
(function () {
    // Avoid double-injection if a page accidentally includes us twice
    if (window.__tgAnalyticsLoaderStarted) return;
    window.__tgAnalyticsLoaderStarted = true;

    // Public values (already exposed via /api/analytics/config). Safe to
    // inline because they're sent to every browser anyway, and inlining
    // removes the extra round-trip that delayed init.
    var TOKEN   = 'eyJhcHBfbmFtZSI6InN0YXJzdG9yZV9hcHAiLCJhcHBfdXJsIjoiaHR0cHM6Ly90Lm1lL1RnU3RhclN0b3JlX2JvdCIsImFwcF9kb21haW4iOiJodHRwczovL3N0YXJzdG9yZS5hcHAifQ==!qjN59/Y8W81DDQBJL4xdsI0tQfjVBGpBWu4jSMOPKjA=';
    var APPNAME = 'starstore_app';

    function init() {
        try {
            if (window.telegramAnalytics && !window.__tgAnalyticsInited) {
                window.telegramAnalytics.init({ token: TOKEN, appName: APPNAME });
                window.__tgAnalyticsInited = true;
            }
        } catch (e) {
            // Never throw from analytics
            console.warn('[tg-analytics] init failed:', e);
        }
    }

    var script = document.createElement('script');
    script.async = true;
    script.src = 'https://tganalytics.xyz/index.js';
    script.onload = init;
    script.onerror = function () {
        console.warn('[tg-analytics] failed to load SDK');
    };
    (document.head || document.documentElement).appendChild(script);
})();
