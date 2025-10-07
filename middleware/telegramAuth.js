const crypto = require('crypto');

function parseInitData(initData) {
  const params = new URLSearchParams(initData || '');
  const data = {};
  for (const [key, value] of params.entries()) {
    data[key] = value;
  }
  try {
    if (data.user) data.user = JSON.parse(data.user);
  } catch (_) {}
  return data;
}

function validateTelegramInitData(initData, botToken) {
  if (!initData || !botToken) return false;
  const data = parseInitData(initData);
  const hash = data.hash;
  if (!hash) return false;
  const entries = Object.keys(data)
    .filter(k => k !== 'hash')
    .sort()
    .map(k => `${k}=${data[k]}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computed = crypto.createHmac('sha256', secret).update(entries).digest('hex');
  return computed === hash;
}

function verifyTelegramAuth(req, _res, next) {
  const initData = req.headers['x-telegram-init-data'] || req.query.initData || '';
  req.telegramInitData = parseInitData(initData);
  next();
}

function requireTelegramAuth(req, res, next) {
  const initDataHeader = req.headers['x-telegram-init-data'] || '';
  const botToken = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;

  if (process.env.NODE_ENV === 'production') {
    // Check for telegram-id header first (most reliable)
    const telegramId = req.headers['x-telegram-id'];
    if (telegramId && telegramId !== 'undefined' && telegramId !== 'null') {
      // Continue to normal processing below
    } else if (initDataHeader && botToken) {
      const valid = validateTelegramInitData(initDataHeader, botToken);
      if (!valid) {
        // Only log auth failures, not every request
        console.log('❌ Telegram auth validation failed:', { 
          hasInitData: !!initDataHeader, 
          hasBotToken: !!botToken,
          initDataLength: initDataHeader.length,
          telegramId: telegramId
        });
        return res.status(401).json({ error: 'Unauthorized' });
      }
    } else {
      // Only log when no auth method is found
      console.log('❌ No valid authentication method found');
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const idFromHeader = req.headers['x-telegram-id'];
  let userId = idFromHeader ? idFromHeader.toString() : undefined;
  if (!userId) {
    try {
      const parsed = parseInitData(initDataHeader);
      if (parsed.user && parsed.user.id) userId = parsed.user.id.toString();
    } catch (_) {}
  }
  if (!userId) userId = 'dev-user';

  const adminEnv = (process.env.ADMIN_TELEGRAM_IDS || process.env.ADMIN_IDS || '').split(',').filter(Boolean).map(s => s.trim());
  req.user = { id: userId, isAdmin: adminEnv.includes(userId) };
  next();
}

function isTelegramUser(req) {
  return !!req.user?.id;
}

module.exports = { verifyTelegramAuth, requireTelegramAuth, isTelegramUser };

