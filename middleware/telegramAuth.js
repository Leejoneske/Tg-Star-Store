
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
  
  // Reduced logging - only log auth failures and important events
  const shouldLog = req.url.includes('/api/export-') || req.url.includes('/api/notifications') || 
                   req.url.includes('/api/admin') || !isValidUserId(req.headers['x-telegram-id']);
  
  if (shouldLog) {
    console.log('🔍 Auth Debug:', {
      url: req.url,
      method: req.method,
      hasInitData: !!initDataHeader,
      telegramIdHeader: req.headers['x-telegram-id'],
      nodeEnv: process.env.NODE_ENV
    });
  }
  
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
  // 🔐 SECURITY: In production, NEVER trust x-telegram-id header alone
  // It can be spoofed by attacker. Only accept x-telegram-init-data with valid signature.
  const telegramIdHeader = req.headers['x-telegram-id'];
  
  // Only use x-telegram-id in development/local mode, NOT in production
  if (isValidUserId(telegramIdHeader) && process.env.NODE_ENV !== 'production') {
    userId = telegramIdHeader.toString();
    authMethod = 'header-dev-only';
    console.log(`[DEV] Using x-telegram-id header (development only): ${userId}`);
  }

  // If no valid header ID, try to extract from initData
  if (!userId && initDataHeader) {
    try {
      const parsed = parseInitData(initDataHeader);
      if (parsed.user && parsed.user.id && isValidUserId(parsed.user.id.toString())) {
        userId = parsed.user.id.toString();
        authMethod = 'initData';
        
        // Validate initData signature in production — REJECT if invalid
        if (process.env.NODE_ENV === 'production') {
          if (!botToken) {
            console.error('❌ BOT_TOKEN not configured in production — cannot verify initData');
            return res.status(500).json({ error: 'Server auth misconfigured' });
          }
          const valid = validateTelegramInitData(initDataHeader, botToken);
          if (!valid) {
            console.warn('❌ Telegram initData signature invalid', { extractedUserId: parsed.user?.id });
            return res.status(401).json({ error: 'Unauthorized - Invalid Telegram signature' });
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
      authMethod
    });
    return res.status(401).json({ error: 'Unauthorized - No valid Telegram authentication' });
  }

  // Fallback for development
  if (!userId) {
    userId = 'dev-user';
    authMethod = 'dev-fallback';
  }

  // Extract username from initData if available
  let username = null;
  if (initDataHeader) {
    try {
      const parsed = parseInitData(initDataHeader);
      if (parsed.user && parsed.user.username) {
        username = parsed.user.username;
      }
    } catch (_) {}
  }

  const adminEnv = (process.env.ADMIN_TELEGRAM_IDS || process.env.ADMIN_IDS || '').split(',').filter(Boolean).map(s => s.trim());
  req.user = { 
    id: userId, 
    username: username,
    isAdmin: adminEnv.includes(userId),
    authMethod // For debugging
  };
  
  // Log auth result only for important endpoints
  if (shouldLog) {
    console.log('✅ Auth result:', { 
      userId, 
      authMethod, 
      isAdmin: req.user.isAdmin,
      url: req.url 
    });
  }
  
  next();
}

function isTelegramUser(req) {
  return !!req.user?.id;
}

module.exports = { verifyTelegramAuth, requireTelegramAuth, isTelegramUser };


