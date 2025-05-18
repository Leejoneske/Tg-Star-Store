// middleware/telegramAuth.js
const crypto = require('crypto');

function verifyTelegramAuth(botToken) {
  return (req, res, next) => {
    // Skip auth for API routes, health checks, and static files
    if (req.path.startsWith('/api') || 
        req.path === '/health' ||
        req.path.startsWith('/public') ||
        req.path === '/telegram-webhook') {
      return next();
    }

    // Check for Telegram WebApp initData
    const initData = req.query.initData || req.headers['telegram-init-data'];
    
    if (initData) {
      try {
        const params = new URLSearchParams(initData);
        const hash = params.get('hash');
        params.delete('hash');
        
        // Create data-check-string
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
          return next();
        }
      } catch (err) {
        console.error('Telegram auth error:', err);
      }
    }

    // Not authenticated - show error page
    return res.status(403).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Telegram Access Required</title>
        <style>
          body { font-family: Arial, sans-serif; text-align: center; padding: 40px; }
          h1 { color: #e74c3c; }
          .btn {
            display: inline-block;
            padding: 12px 24px;
            background: #0088cc;
            color: white;
            text-decoration: none;
            border-radius: 4px;
            margin-top: 20px;
            font-weight: bold;
          }
        </style>
      </head>
      <body>
        <h1>Please open in Telegram</h1>
        <p>This application can only be accessed through the Telegram app.</p>
        <a href="https://t.me/${process.env.BOT_USERNAME}" class="btn">Open in Telegram</a>
        <script>
          // Try to detect if we're in Telegram
          if (window.Telegram && window.Telegram.WebApp) {
            window.Telegram.WebApp.expand();
          }
        </script>
      </body>
      </html>
    `);
  };
}

module.exports = verifyTelegramAuth;
