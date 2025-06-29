
const crypto = require('crypto');

/**
 * Verifies Telegram Web App init data
 * @param {string} initData - The init data from Telegram Web App
 * @returns {Object|null} - Parsed user data if valid, null if invalid
 */
function verifyTelegramWebAppData(initData) {
    try {
        if (!initData || !process.env.BOT_TOKEN) {
            return null;
        }

        // Parse the init data
        const urlParams = new URLSearchParams(initData);
        const hash = urlParams.get('hash');
        urlParams.delete('hash');

        // Create data check string
        const dataCheckString = Array.from(urlParams.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, value]) => `${key}=${value}`)
            .join('\n');

        // Create secret key
        const secretKey = crypto
            .createHmac('sha256', 'WebAppData')
            .update(process.env.BOT_TOKEN)
            .digest();

        // Calculate hash
        const calculatedHash = crypto
            .createHmac('sha256', secretKey)
            .update(dataCheckString)
            .digest('hex');

        // Verify hash
        if (calculatedHash !== hash) {
            return null;
        }

        // Parse user data
        const userParam = urlParams.get('user');
        if (!userParam) {
            return null;
        }

        const userData = JSON.parse(userParam);
        
        // Check auth date (optional - verify data is not too old)
        const authDate = urlParams.get('auth_date');
        if (authDate) {
            const authTimestamp = parseInt(authDate);
            const currentTimestamp = Math.floor(Date.now() / 1000);
            const maxAge = 86400; // 24 hours in seconds
            
            if (currentTimestamp - authTimestamp > maxAge) {
                return null; // Data is too old
            }
        }

        return {
            user: userData,
            auth_date: authDate,
            query_id: urlParams.get('query_id'),
            start_param: urlParams.get('start_param')
        };
    } catch (error) {
        console.error('Error verifying Telegram Web App data:', error);
        return null;
    }
}

/**
 * Express middleware to require Telegram authentication
 */
function requireTelegramAuth(req, res, next) {
    const initData = req.headers['x-telegram-init-data'] || req.body.initData || req.query.initData;
    
    if (!initData) {
        return res.status(401).json({ error: 'Telegram authentication required' });
    }

    const verifiedData = verifyTelegramWebAppData(initData);
    
    if (!verifiedData) {
        return res.status(401).json({ error: 'Invalid Telegram authentication' });
    }

    // Add user data to request object
    req.telegramUser = verifiedData.user;
    req.telegramData = verifiedData;
    
    next();
}

/**
 * Express middleware to optionally verify Telegram authentication
 */
function verifyTelegramAuth(req, res, next) {
    const initData = req.headers['x-telegram-init-data'] || req.body.initData || req.query.initData;
    
    if (initData) {
        const verifiedData = verifyTelegramWebAppData(initData);
        if (verifiedData) {
            req.telegramUser = verifiedData.user;
            req.telegramData = verifiedData;
        }
    }
    
    next();
}

module.exports = {
    verifyTelegramWebAppData,
    requireTelegramAuth,
    verifyTelegramAuth
};
