
const crypto = require('crypto');

function verifyTelegramWebAppData(initData) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    params.delete('hash');
    
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    
    const secret = crypto.createHmac('sha256', 'WebAppData')
      .update(process.env.BOT_TOKEN).digest();
    
    return crypto.createHmac('sha256', secret)
      .update(dataCheckString).digest('hex') === hash;
  } catch (e) {
    return false;
  }
}

function isTelegramUser(req) {
  const initData = req.headers['x-telegram-init-data'] || req.query.tgWebAppData;
  if (initData && verifyTelegramWebAppData(initData)) return true;
  
  const ua = req.headers['user-agent'] || '';
  if (ua.includes('Telegram')) return true;
  
  return (req.headers['x-telegram-bot-api-secret-token'] || 
          req.headers.referer || '').includes('t.me');
}

function requireTelegramAuth(req, res, next) {
  isTelegramUser(req) ? next() : res.status(403).json({ error: 'Telegram access required' });
}

module.exports = { requireTelegramAuth, isTelegramUser };
