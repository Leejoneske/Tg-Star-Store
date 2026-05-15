
(function() {
    // Only load analytics if running in Telegram WebApp
    if (!window.Telegram?.WebApp) {
        return;
    }

    // Fetch analytics configuration from server
    fetch('/api/analytics/config')
        .then(response => response.json())
        .then(config => {
            const script = document.createElement('script');
            script.src = 'https://tganalytics.xyz/index.js';
            script.async = true;
            script.onload = function() {
                const waitForTelegram = setInterval(() => {
                    if (window.Telegram?.WebApp?.initData) {
                        clearInterval(waitForTelegram);
                        if (window.telegramAnalytics) {
                            window.telegramAnalytics.init({
                                token: config.token,
                                appName: config.appName
                            });
                        }
                    }
                }, 50);
                setTimeout(() => clearInterval(waitForTelegram), 3000);
            };
            document.head.appendChild(script);
        })
        .catch(error => {
            console.warn('Failed to load analytics config:', error);
        });
})();
