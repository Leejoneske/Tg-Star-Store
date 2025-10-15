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
  
  // Debug logging
  console.log('🔍 Auth Debug - Request:', {
    url: req.url,
    method: req.method,
    hasInitData: !!initDataHeader,
    initDataLength: initDataHeader.length,
    telegramIdHeader: req.headers['x-telegram-id'],
    hasBotToken: !!botToken,
    nodeEnv: process.env.NODE_ENV
  });
  
  // Helper function to check if a value is a valid user ID
  function isValidUserId(value) {
    if (!value) return false;
    
    // Convert to string for consistent checking
    const strValue = String(value);
    
    // Check for invalid string representations
    if (strValue === 'undefined' || strValue === 'null' || strValue === 'NaN' || strValue === '') {
      return false;
    }
    
    // Allow dev-user in development
    if (strValue === 'dev-user' && process.env.NODE_ENV !== 'production') {
      return true;
    }
    
    // For production, ensure it's a valid user ID (numeric or valid string)
    return strValue.trim().length > 0 && strValue !== 'dev-user';
  }

  let userId = null;
  let authMethod = 'none';

  // First, try to extract user ID from x-telegram-id header
  const telegramIdHeader = req.headers['x-telegram-id'];
  if (isValidUserId(telegramIdHeader)) {
    userId = telegramIdHeader.toString();
    authMethod = 'header';
  }

  // If no valid header ID, try to extract from initData
  if (!userId && initDataHeader) {
    try {
      const parsed = parseInitData(initDataHeader);
      if (parsed.user && parsed.user.id && isValidUserId(parsed.user.id.toString())) {
        userId = parsed.user.id.toString();
        authMethod = 'initData';
        
        // Validate initData signature if in production
        if (process.env.NODE_ENV === 'production' && botToken) {
          const valid = validateTelegramInitData(initDataHeader, botToken);
          if (!valid) {
            console.log('❌ Telegram auth validation failed:', { 
              hasInitData: !!initDataHeader, 
              hasBotToken: !!botToken,
              initDataLength: initDataHeader.length,
              telegramIdHeader: telegramIdHeader || 'undefined',
              extractedUserId: parsed.user?.id || 'undefined',
              authMethod
            });
            return res.status(401).json({ error: 'Invalid Telegram authentication' });
          }
        }
      }
    } catch (error) {
      console.log('❌ Error parsing initData:', error.message);
    }
  }

  // Production validation
  if (process.env.NODE_ENV === 'production' && !userId) {
    console.log('❌ No valid authentication found:', {
      hasInitData: !!initDataHeader,
      hasBotToken: !!botToken,
      telegramIdHeader: telegramIdHeader || 'undefined',
      authMethod
    });
    return res.status(401).json({ error: 'Unauthorized - No valid Telegram authentication' });
  }

  // Fallback for development
  if (!userId) {
    userId = 'dev-user';
    authMethod = 'dev-fallback';
  }

  const adminEnv = (process.env.ADMIN_TELEGRAM_IDS || process.env.ADMIN_IDS || '').split(',').filter(Boolean).map(s => s.trim());
  req.user = { 
    id: userId, 
    isAdmin: adminEnv.includes(userId),
    authMethod // For debugging
  };
  
  // Log auth result
  console.log('✅ Auth result:', { 
    userId, 
    authMethod, 
    isAdmin: req.user.isAdmin,
    url: req.url 
  });
  
  next();
}

function isTelegramUser(req) {
  return !!req.user?.id;
}

module.exports = { verifyTelegramAuth, requireTelegramAuth, isTelegramUser };

