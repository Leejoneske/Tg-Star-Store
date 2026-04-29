(function initGlobalTheme() {
	try {
		var root = document.documentElement;
		var storageKey = 'theme_preference';
		var appThemeKey = 'appTheme'; // Legacy theme key used by the app

		function applyTheme(mode) {
			if (mode === 'dark') {
				root.setAttribute('data-theme', 'dark');
				document.body.setAttribute('data-theme', 'dark');
				return;
			}
			if (mode === 'light') {
				root.removeAttribute('data-theme');
				document.body.removeAttribute('data-theme');
				return;
			}
			// system
			if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
				root.setAttribute('data-theme', 'dark');
				document.body.setAttribute('data-theme', 'dark');
			} else {
				root.removeAttribute('data-theme');
				document.body.removeAttribute('data-theme');
			}
		}

		function getStoredPreference() {
			try { 
				// First check for new theme preference key
				var newPref = localStorage.getItem(storageKey);
				if (newPref) return newPref;
				
				// Fallback to legacy appTheme storage key
				var legacyTheme = localStorage.getItem(appThemeKey);
				if (legacyTheme === 'dark') return 'dark';
				if (legacyTheme === 'light') return 'light';
				
				return 'system'; 
			} catch(_) { return 'system'; }
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
				var stored = getStoredPreference();
				
				// Don't override user's saved preference with Telegram theme
				// Only use Telegram theme if user hasn't set a preference
				if (stored === 'system' && tg.colorScheme === 'dark') {
					root.setAttribute('data-theme', 'dark');
					document.body.setAttribute('data-theme', 'dark');
				}
			}
		} catch(_) {}

		// Initial apply
		applyTheme(getStoredPreference());
		listenToSystemChanges();

		// Expose API for manual toggles
		window.Theme = {
			set: function(mode) {
				if (!mode || (mode !== 'light' && mode !== 'dark' && mode !== 'system')) mode = 'system';
				try { localStorage.setItem(storageKey, mode); } catch(_) {}
				applyTheme(mode);
			},
			get: function() { return getStoredPreference(); },
			// Ensure theme persists even after errors
			persist: function() {
				var pref = getStoredPreference();
				applyTheme(pref);
			}
		};
		
		// Re-apply theme if page reconnects or recovers from errors
		window.addEventListener('connection-restored', function() {
			window.Theme && window.Theme.persist && window.Theme.persist();
		});
		
	} catch(_) {}
})();

