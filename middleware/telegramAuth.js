
const crypto = require('crypto');

// Validate Telegram Web App initData
function verify TelegramWebAppData(initData) {
    if (!initData) {
        console.error('No initData provided for verification');
        return false;
    }

    try {
        const params = new URLSearchParams(initData);
        const hash = params.get('hash');
        if (!hash) {
            console.error('No hash found in initData');
            return false;
        }
        params.delete('hash');

        const dataCheckString = [...params.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${k}=${v}`)
            .join('\n');

        const secret = crypto.createHmac('sha256', 'WebAppData')
            .update(process.env.BOT_TOKEN || '')
            .digest();

        const computedHash = crypto.createHmac('sha256', secret)
            .update(dataCheckString)
            .digest('hex');

        if (computedHash !== hash) {
            console.error('Invalid initData hash');
            return false;
        }

        return true;
    } catch (error) {
        console.error('Error verifying initData:', error.message);
        return false;
    }
}

// Middleware to require Telegram Web App authentication
function requireTelegramAuth(req, res, next) {
    const initData = req.headers['x-telegram-init-data'] || req.query.tgWebAppData;
    if (verifyTelegramWebAppData(initData)) {
        next();
    } else {
        console.error(`Unauthorized access attempt: ${req.method} ${req.url}`);
        res.status(403).json({
            error: 'Access denied',
            message: 'This application can only be accessed through Telegram Web App'
        });
    }
}

module.exports = {
    verifyTelegramWebAppData,
    requireTelegramAuth
};
