 // telegramAuth.js
const crypto = require('crypto');

function verifyTelegramAuth(botToken) {
  return (req, res, next) => {
    // Skip auth check for API routes and health check
    if (req.path.startsWith('/api') || req.path === '/health') {
      return next();
    }

    // Skip auth check for webhook path
    if (req.path === '/telegram-webhook') {
      return next();
    }

    // Check for Telegram WebApp initData
    const initData = req.headers['telegram-init-data'] || req.query.initData;
    
    if (initData) {
      try {
        const params = new URLSearchParams(initData);
        const hash = params.get('hash');
        params.delete('hash');
        
        // Recreate data-check-string
        const dataCheckString = Array.from(params.entries())
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, value]) => `${key}=${value}`)
          .join('\n');
        
        // Verify hash
        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
        const calculatedHash = crypto.createHmac('sha256', secretKey)
          .update(dataCheckString)
          .digest('hex');
        
        if (calculatedHash === hash) {
          // Authentication successful
          return next();
        }
      } catch (err) {
        console.error('Telegram auth error:', err);
      }
    }

    // Not authenticated - redirect to bot
    const botUrl = `https://t.me/${process.env.BOT_USERNAME}`;
    const webAppUrl = encodeURIComponent(req.protocol + '://' + req.get('host') + req.originalUrl);
    const redirectUrl = `${botUrl}?startapp=${webAppUrl}`;
    
    if (req.headers.accept?.includes('text/html')) {
      // For browser requests, redirect to HTML page with button
      return res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Redirect to Telegram</title>
          <meta property="og:title" content="Open in Telegram">
          <meta property="og:description" content="Please open this link in Telegram to continue">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            body { font-family: Arial, sans-serif; text-align: center; padding: 20px; }
            .btn { display: inline-block; padding: 10px 20px; background: #0088cc; 
                   color: white; text-decoration: none; border-radius: 5px; margin-top: 20px; }
          </style>
        </head>
        <body>
          <h1>Please open in Telegram</h1>
          <p>This page is only accessible through the Telegram app.</p>
          <a href="${redirectUrl}" class="btn">Open in Telegram</a>
          <script>
            // Try to detect Telegram WebApp
            if (window.Telegram && window.Telegram.WebApp) {
              window.location.href = "${redirectUrl}";
            }
          </script>
        </body>
        </html>
      `);
    } else {
      // For API requests, return 403
      return res.status(403).json({ 
        error: 'Unauthorized', 
        message: 'Please access this through Telegram',
        telegram_bot_url: redirectUrl
      });
    }
  };
}

module.exports = verifyTelegramAuth;
