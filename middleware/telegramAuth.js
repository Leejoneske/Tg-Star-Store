const crypto = require('crypto');

module.exports = (botToken, botUsername) => {
  return (req, res, next) => {
    const initData = req.query.initData || req.headers['init-data'];
    
    if (!initData) {
      const isTelegram = req.headers['user-agent']?.includes('Telegram') || 
                        req.headers['sec-fetch-site'] === 'none';
      
      if (!isTelegram) {
        return res.redirect(`https://t.me/${botUsername}`);
      }
      return next();
    }

    try {
      const secret = crypto.createHash('sha256').update(botToken).digest();
      const params = new URLSearchParams(initData);
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
        req.telegramUser = JSON.parse(params.get('user'));
        return next();
      }
      
      return res.redirect(`https://t.me/${botUsername}`);
    } catch (error) {
      return res.redirect(`https://t.me/${botUsername}`);
    }
  };
};
