/**
 * Shared Sonner-style toast notification system.
 * Use anywhere via:
 *   Toast.show(message, type, duration)
 *   Toast.info(msg) / Toast.success(msg) / Toast.warning(msg) / Toast.error(msg)
 *
 * Backward compatibility: also exposed as window.ToastNotification.
 */
(function () {
    if (window.Toast && window.Toast.__starstore) return;

    var ICONS = {
        info:    { color: '#3b82f6', svg: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>' },
        success: { color: '#10b981', svg: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>' },
        warning: { color: '#f59e0b', svg: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>' },
        error:   { color: '#ef4444', svg: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/></svg>' }
    };

    function ensureStyles() {
        if (document.getElementById('sonnerToastStyles')) return;
        var style = document.createElement('style');
        style.id = 'sonnerToastStyles';
        style.textContent = [
            '#toastContainer{position:fixed!important;top:max(16px,env(safe-area-inset-top,0px))!important;right:max(16px,env(safe-area-inset-right,0px))!important;left:auto!important;z-index:2147483647!important;display:flex;flex-direction:column;gap:8px;pointer-events:none;max-width:min(380px,calc(100vw - 32px))}',
            '.sonner-toast{display:flex;align-items:center;gap:10px;background:#fff;color:#0f172a;padding:12px 14px;border-radius:12px;font-size:14px;font-weight:500;line-height:1.35;border:1px solid rgba(0,0,0,.06);box-shadow:0 6px 24px rgba(0,0,0,.10),0 1px 2px rgba(0,0,0,.04);pointer-events:auto;animation:sonnerIn .24s cubic-bezier(.21,1.02,.73,1) both;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}',
            '.sonner-toast.sonner-out{animation:sonnerOut .2s ease-in forwards}',
            '.sonner-icon{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center}',
            '.sonner-msg{flex:1;min-width:0;word-break:break-word}',
            '[data-theme="dark"] .sonner-toast,.dark .sonner-toast{background:#1f2937;color:#f1f5f9;border-color:rgba(255,255,255,.08);box-shadow:0 6px 24px rgba(0,0,0,.45),0 1px 2px rgba(0,0,0,.30)}',
            '@keyframes sonnerIn{from{transform:translateX(110%);opacity:0}to{transform:translateX(0);opacity:1}}',
            '@keyframes sonnerOut{from{transform:translateX(0);opacity:1}to{transform:translateX(110%);opacity:0}}'
        ].join('');
        document.head.appendChild(style);
    }

    function ensureContainer() {
        var c = document.getElementById('toastContainer');
        if (c) return c;
        c = document.createElement('div');
        c.id = 'toastContainer';
        (document.body || document.documentElement).appendChild(c);
        return c;
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    var Toast = {
        __starstore: true,
        show: function (message, type, duration) {
            try {
                type = type || 'info';
                duration = typeof duration === 'number' ? duration : 3000;
                ensureStyles();
                var container = ensureContainer();
                var meta = ICONS[type] || ICONS.info;
                var el = document.createElement('div');
                el.className = 'sonner-toast sonner-' + type;
                el.innerHTML =
                    '<span class="sonner-icon" style="color:' + meta.color + ';">' + meta.svg + '</span>' +
                    '<span class="sonner-msg">' + escapeHtml(message) + '</span>';
                container.appendChild(el);
                setTimeout(function () {
                    el.classList.add('sonner-out');
                    setTimeout(function () { el.remove(); }, 220);
                }, duration);
            } catch (e) { /* never throw from a toast */ }
        },
        info:    function (m, d) { this.show(m, 'info', d); },
        success: function (m, d) { this.show(m, 'success', d); },
        warning: function (m, d) { this.show(m, 'warning', d); },
        error:   function (m, d) { this.show(m, 'error', d); }
    };

    window.Toast = Toast;
    // Backward-compat alias used by older inline code
    window.ToastNotification = Toast;
})();
