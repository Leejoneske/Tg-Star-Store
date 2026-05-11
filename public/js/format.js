/**
 * Tiny shared number/currency formatters. Available globally as window.Fmt.
 * Safe to load anywhere — no dependencies, no side effects.
 */
(function () {
    if (window.Fmt) return;

    function getLocale() {
        try {
            return (window.currentLanguage && String(window.currentLanguage)) ||
                (navigator.language || 'en-US');
        } catch (_) { return 'en-US'; }
    }

    function num(value, opts) {
        var n = Number(value);
        if (!isFinite(n)) return String(value == null ? '' : value);
        try {
            return new Intl.NumberFormat(getLocale(), opts || {}).format(n);
        } catch (_) {
            // Fallback with manual thousands separator
            var parts = n.toFixed(opts && opts.maximumFractionDigits != null ? opts.maximumFractionDigits : 2).split('.');
            parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
            return parts.join('.');
        }
    }

    window.Fmt = {
        /** Integer with thousands separators: 1234 → "1,234" */
        int: function (v) { return num(v, { maximumFractionDigits: 0 }); },
        /** Stars: integer + thousands sep */
        stars: function (v) { return num(v, { maximumFractionDigits: 0 }); },
        /** USDT: up to 2 fraction digits, always at least 2 if there are any decimals */
        usdt: function (v) {
            var n = Number(v);
            if (!isFinite(n)) return String(v == null ? '' : v);
            return num(n, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        },
        /** TON: 2–4 fraction digits */
        ton: function (v) {
            return num(v, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
        },
        /** Generic with options */
        num: num
    };
})();
