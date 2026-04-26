
(function() {
    const script = document.createElement('script');
    script.src = 'https://tganalytics.xyz/index.js';
    script.async = true;
    script.onload = function() {
        const waitForTelegram = setInterval(() => {
            if (window.Telegram?.WebApp?.initData) {
                clearInterval(waitForTelegram);
                if (window.telegramAnalytics) {
                    window.telegramAnalytics.init({
                        token: 'eyJhcHBfbmFtZSI6InN0YXJzdG9yZSIsImFwcF91cmwiOiJodHRwczovL3QubWUvVGdTdGFyU3RvcmVfYm90IiwiYXBwX2RvbWFpbiI6Imh0dHBzOi8vc3RhcnN0b3JlLnNpdGUifQ==!p6+pJ88q7iIxa8nf+x+jWQshXdMnNYE4MjiRq2wWP3M=',
                        appName: 'starstore'
                    });
                }
            }
        }, 50);
        setTimeout(() => clearInterval(waitForTelegram), 3000);
    };
    document.head.appendChild(script);
})();
