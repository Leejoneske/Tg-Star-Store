/**
 * Admin Telegram Commands Module
 * This module is kept for compatibility but the /sendemail command
 * is now handled directly in server.js as an interactive session
 */

module.exports = function registerAdminEmailCommands(bot, adminIds, emailService) {
    if (!bot || typeof bot.onText !== 'function') {
        console.warn('[Admin Commands] Bot object not ready, skipping registration');
        return;
    }

    console.log('[Admin Commands] Module loaded (interactive commands handled in server.js)');
};
