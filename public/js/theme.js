(function initGlobalTheme() {
	try {
		var root = document.documentElement;
		var storageKey = 'theme_preference';

		function applyTheme(mode) {
			if (mode === 'dark') {
				root.setAttribute('data-theme', 'dark');
				return;
			}
			if (mode === 'light') {
				root.removeAttribute('data-theme');
				return;
			}
			// system
			if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
				root.setAttribute('data-theme', 'dark');
			} else {
				root.removeAttribute('data-theme');
			}
		}

		function getStoredPreference() {
			try { return localStorage.getItem(storageKey) || 'system'; } catch(_) { return 'system'; }
		}

		function listenToSystemChanges() {
			if (!window.matchMedia) return;
			var mql = window.matchMedia('(prefers-color-scheme: dark)');
			var handler = function(e) {
				if (getStoredPreference() === 'system') {
					applyTheme('system');
				}
			};
			if (typeof mql.addEventListener === 'function') mql.addEventListener('change', handler);
			else if (typeof mql.addListener === 'function') mql.addListener(handler);
		}

		// Telegram WebApp integration (if available)
		try {
			var tg = window.Telegram && window.Telegram.WebApp;
			if (tg) {
				tg.ready && tg.ready();
				if (tg.colorScheme === 'dark' && getStoredPreference() === 'system') {
					root.setAttribute('data-theme', 'dark');
				}
			}
		} catch(_) {}

		// Initial apply
		applyTheme(getStoredPreference());
		listenToSystemChanges();

		// Expose minimal API for optional manual toggles
		window.Theme = {
			set: function(mode) {
				if (!mode || (mode !== 'light' && mode !== 'dark' && mode !== 'system')) mode = 'system';
				try { localStorage.setItem(storageKey, mode); } catch(_) {}
				applyTheme(mode);
			},
			get: function() { return getStoredPreference(); }
		};
	} catch(_) {}
})();

