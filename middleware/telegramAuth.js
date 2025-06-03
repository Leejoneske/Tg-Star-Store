const crypto = require('crypto');

// Verify Telegram Web App data
function verifyTelegramWebAppData(initData, botToken) {
  if (!initData) return false;
  
  try {
    const urlParams = new URLSearchParams(initData);
    const hash = urlParams.get('hash');
    urlParams.delete('hash');
    
    const dataCheckString = Array.from(urlParams.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    
    return calculatedHash === hash;
  } catch (error) {
    console.error('Telegram auth verification error:', error);
    return false;
  }
}

// Check if request is from Telegram
function isTelegramUser(req) {
  // Check for Telegram Web App init data
  const initData = req.headers['x-telegram-init-data'] || 
                   req.query.tgWebAppData || 
                   req.body.initData;
  
  if (initData && verifyTelegramWebAppData(initData, process.env.BOT_TOKEN)) {
    return true;
  }
  
  // Check User-Agent for Telegram
  const userAgent = req.headers['user-agent'] || '';
  if (userAgent.includes('TelegramBot') || userAgent.includes('Telegram')) {
    return true;
  }
  
  // Check for Telegram-specific headers
  if (req.headers['x-telegram-bot-api-secret-token']) {
    return true;
  }
  
  // Check referer for Telegram Web App
  const referer = req.headers['referer'] || '';
  if (referer.includes('t.me') || referer.includes('telegram')) {
    return true;
  }
  
  return false;
}

// Middleware to restrict access to Telegram users only
function requireTelegramAuth(req, res, next) {
  if (isTelegramUser(req)) {
    next();
  } else {
    // Redirect to error page or show access denied
    res.status(403).sendFile('public/403.html', { root: '.' }, (err) => {
      if (err) {
        res.status(403).json({ 
          error: 'Access denied. This page is only accessible through Telegram.' 
        });
      }
    });
  }
}

module.exports = {
  requireTelegramAuth,
  isTelegramUser,
  verifyTelegramWebAppData
};
