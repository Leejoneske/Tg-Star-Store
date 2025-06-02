 const crypto = require('crypto');

module.exports = (botToken, botUsername, options = {}) => {
  // Default options with ability to override
  const config = {
    publicPaths: [],
    redirectUnauthorized: true,
    ...options
  };

  return (req, res, next) => {
    // Skip auth for public paths
    if (config.publicPaths.some(path => req.path.startsWith(path))) {
      return next();
    }

    const initData = req.query.initData || req.headers['init-data'];
    
    // Case 1: No initData - check if request comes from Telegram
    if (!initData) {
      const isTelegram = req.headers['user-agent']?.includes('Telegram') || 
                        req.headers['sec-fetch-site'] === 'none';
      
      if (!isTelegram) {
        if (config.redirectUnauthorized) {
          // Clean path and remove leading slash for deep linking
          const cleanPath = req.path.replace(/^\/|\/$/g, '');
          return res.redirect(`https://t.me/${botUsername}?start=web_${cleanPath}`);
        }
        return res.status(401).json({ error: 'Telegram authentication required' });
      }
      return next();
    }

    // Case 2: Validate initData
    try {
      const secret = crypto.createHash('sha256').update(botToken).digest();
      const params = new URLSearchParams(initData);
      
      // Validate hash
      const hash = params.get('hash');
      params.delete('hash');
      
      const dataToCheck = Array.from(params.entries())
        .map(([key, value]) => `${key}=${value}`)
        .sort()
        .join('\n');
      
      const calculatedHash = crypto
        .createHmac('sha256', secret)
        .update(dataToCheck)
        .digest('hex');
      
      if (calculatedHash === hash) {
        // Store user data in request
        req.telegramUser = JSON.parse(params.get('user'));
        req.telegramInitData = Object.fromEntries(params);
        return next();
      }
      
      // Hash mismatch
      if (config.redirectUnauthorized) {
        return res.redirect(`https://t.me/${botUsername}`);
      }
      return res.status(401).json({ error: 'Invalid Telegram authentication' });
      
    } catch (error) {
      console.error('Telegram auth error:', error);
      if (config.redirectUnauthorized) {
        return res.redirect(`https://t.me/${botUsername}`);
      }
      return res.status(401).json({ error: 'Authentication failed' });
    }
  };
};
