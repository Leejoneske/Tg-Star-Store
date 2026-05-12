
// Shared bottom navigation utilities + auto-injection.
// Any page that includes <div id="bottomnav-container"></div> in its markup
// will automatically have /bottomnav.html fetched, injected, and initialized.
window.BottomNavUtils = {
    getCurrentPage() {
        const path = window.location.pathname;
        const filename = path.split('/').pop();

        if (filename === 'amb_ref.html' || path.includes('amb_ref')) {
            return 'referral';
        }

        switch (filename) {
            case 'index.html':
            case '':
            case 'app':
            case '/':
                return 'home';
            case 'sell.html':
            case 'sell':
                return 'sell';
            case 'history.html':
            case 'history':
                return 'history';
            case 'referral.html':
            case 'referral':
                return 'referral';
            case 'about.html':
            case 'about':
                return 'about';
            default:
                return 'home';
        }
    },

    setActiveNavigation() {
        const currentPage = this.getCurrentPage();
        const navLinks = document.querySelectorAll('.nav-link');
        if (navLinks.length === 0) return;
        navLinks.forEach(link => {
            link.classList.remove('active');
            if (link.getAttribute('data-page') === currentPage) {
                link.classList.add('active');
            }
        });
    },

    initBottomNav() {
        this.setActiveNavigation();
    },

    /**
     * Fetch /bottomnav.html and inject it into #bottomnav-container.
     * Idempotent — safe to call multiple times.
     * Returns a Promise that resolves when injection + init are complete.
     */
    async loadBottomNav() {
        const container = document.getElementById('bottomnav-container');
        if (!container) return;
        if (container.dataset.loaded === 'true') return;

        try {
            const r = await fetch('/bottomnav.html', { cache: 'no-cache' });
            if (!r.ok) {
                console.error('Failed to load bottomnav.html:', r.status, r.statusText);
                return;
            }
            const html = await r.text();
            if (!html.trim()) return;

            container.innerHTML = html;
            container.dataset.loaded = 'true';

            this.initBottomNav();
            this.setupAmbassadorRedirect();

            // Apply translations to the freshly injected nav
            if (window.TranslationUtils && typeof window.TranslationUtils.applyTranslations === 'function') {
                try { window.TranslationUtils.applyTranslations(); } catch (_) {}
            }
        } catch (err) {
            console.error('Error loading bottom nav:', err);
        }
    },

    /**
     * Prewarm ambassador status cache and intercept referral-link clicks so
     * ambassadors are routed directly to /amb_ref.html without a flash of the
     * regular referral page.
     */
    setupAmbassadorRedirect() {
        const CACHE_KEY = 'ambassadorStatus_v1';
        const TTL = 30 * 60 * 1000;

        const getUserId = () => {
            try {
                const id = window.Telegram?.WebApp?.initDataUnsafe?.user?.id;
                if (id && String(id) !== 'undefined') return String(id);
            } catch (_) {}
            try {
                if (window.authenticatedUserId) return String(window.authenticatedUserId);
            } catch (_) {}
            try {
                const s = localStorage.getItem('userId');
                if (s && s !== 'undefined' && s !== 'null' && s !== 'dev-user') return s;
            } catch (_) {}
            return null;
        };

        const readCache = (uid) => {
            try {
                const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
                if (c && c.userId === uid && (Date.now() - c.timestamp) < TTL) return c.isAmbassador;
            } catch (_) {}
            return null;
        };
        const writeCache = (uid, v) => {
            try { localStorage.setItem(CACHE_KEY, JSON.stringify({ userId: uid, isAmbassador: v, timestamp: Date.now() })); } catch (_) {}
        };

        const prewarm = () => {
            const uid = getUserId();
            if (!uid) return;
            if (readCache(uid) !== null) return;
            fetch(`/api/check-ambassador?userId=${encodeURIComponent(uid)}`, { signal: AbortSignal.timeout(3000) })
                .then(r => r.ok ? r.json() : null)
                .then(d => { if (d) writeCache(uid, !!d.isAmbassador); })
                .catch(() => {});
        };

        // Attempt prewarm now and again shortly after Telegram is ready
        prewarm();
        setTimeout(prewarm, 400);

        // Intercept clicks on the referral nav link
        const link = document.querySelector('.nav-link[data-page="referral"]');
        if (link) {
            link.addEventListener('click', (e) => {
                const uid = getUserId();
                if (!uid) return;
                const status = readCache(uid);
                if (status === true && !location.pathname.includes('amb_ref')) {
                    e.preventDefault();
                    window.location.href = '/amb_ref.html';
                }
            }, { capture: true });
        }
    }
};

// Auto-inject on DOM ready so individual pages don't have to duplicate the loader.
(function autoInit() {
    const run = () => window.BottomNavUtils.loadBottomNav();
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', run, { once: true });
    } else {
        run();
    }
})();

