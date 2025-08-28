// Configuration constants
const SERVER_URL = (process.env.RAILWAY_STATIC_URL || 
                   process.env.RAILWAY_PUBLIC_DOMAIN || 
                   'tg-star-store-production.up.railway.app');
const WEBHOOK_PATH = '/telegram-webhook';
const WEBHOOK_URL = `https://${SERVER_URL}${WEBHOOK_PATH}`;

// Admin IDs
const adminIds = process.env.ADMIN_TELEGRAM_IDS.split(',').map(id => id.trim());

module.exports = {
    SERVER_URL,
    WEBHOOK_PATH,
    WEBHOOK_URL,
    adminIds
};