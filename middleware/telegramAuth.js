

// middleware/telegramAuth.js
const crypto = require('crypto');
const path = require('path');

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
      .update(process.env.TELEGRAM_BOT_TOKEN).digest();
    
    const calc = crypto.createHmac('sha256', secret)
      .update(dataCheckString).digest('hex');
    const hashBuf = Buffer.from(hash, 'hex');
    const calcBuf = Buffer.from(calc, 'hex');
    if (hashBuf.length !== calcBuf.length) return false;
    return crypto.timingSafeEqual(hashBuf, calcBuf);
  } catch (e) {
    return false;
  }
}

function verifyTelegramAuth(initData) {
  return verifyTelegramWebAppData(initData);
}

function parseTelegramInitData(initData) {
  const params = new URLSearchParams(initData);
  const userJson = params.get('user');
  const authDate = Number(params.get('auth_date')) || 0;
  try {
    const user = userJson ? JSON.parse(userJson) : null;
    return { user, authDate };
  } catch { return null; }
}

function isTelegramUser(req) {
  const initData = req.headers['x-telegram-init-data'] || req.query.tgWebAppData;
  if (!initData) return false;
  if (!verifyTelegramWebAppData(initData)) return false;
  const parsed = parseTelegramInitData(initData);
  if (!parsed || !parsed.user || !parsed.user.id) return false;
  // Freshness check with configurable tolerance (default 300s)
  const now = Math.floor(Date.now() / 1000);
  const maxAgeSecRaw = parseInt(process.env.TELEGRAM_INIT_MAX_AGE_SECONDS || '300', 10);
  const maxAgeSec = Number.isFinite(maxAgeSecRaw) ? Math.max(30, Math.min(maxAgeSecRaw, 86400)) : 300;
  if (!parsed.authDate || now - parsed.authDate > maxAgeSec) return false;
  const user = parsed.user;
  if (user.id) {
    req.verifiedTelegramUser = { id: user.id.toString(), username: user.username };
  }
  return true;
}

function requireTelegramAuth(req, res, next) {
  if (isTelegramUser(req)) {
    // If client sent x-telegram-id, ensure it matches verified user
    const claimedId = (req.headers['x-telegram-id'] || req.query.telegramId || '').toString();
    if (claimedId && req.verifiedTelegramUser?.id && claimedId !== req.verifiedTelegramUser.id) {
      return res.status(403).json({ error: 'Telegram identity mismatch' });
    }
    next();
  } else {
    res.status(403).json({ 
      error: 'Access denied', 
      message: 'This application can only be accessed through Telegram' 
    });
  }
}

module.exports = { 
  verifyTelegramAuth, 
  verifyTelegramWebAppData,
  requireTelegramAuth, 
  isTelegramUser 
};
