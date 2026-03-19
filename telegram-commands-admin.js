/**
 * Admin Telegram Commands for Email Sending
 * Exposed via bot instance in main server.js
 */

module.exports = function registerAdminEmailCommands(bot, adminIds, emailService) {
    if (!bot || typeof bot.onText !== 'function') {
        console.warn('[Admin Commands] Bot object not ready, skipping command registration');
        return;
    }

    if (!Array.isArray(adminIds)) {
        console.warn('[Admin Commands] adminIds not an array, skipping registration');
        return;
    }

    if (!emailService || typeof emailService.sendCustomEmail !== 'function') {
        console.warn('[Admin Commands] emailService.sendCustomEmail not available, skipping registration');
        return;
    }

    console.log(`[Admin Commands] Registering with ${adminIds.length} admin IDs`);

    // Admin command: Send custom email to users
    // Usage: /sendemail user@email.com "Email Subject" "HTML body content"
    bot.onText(/\/sendemail\s+(\S+)\s+"([^"]+)"\s+"(.+)"$/i, async (msg, match) => {
        try {
            const chatId = msg.chat.id;
            const requesterId = msg.from.id.toString();
            
            console.log(`[/sendemail] Command received from ${requesterId}`);
        
        if (!adminIds.includes(requesterId)) {
            return bot.sendMessage(chatId, '⛔ **Access Denied**\n\nInsufficient privileges to execute this command.', {
                parse_mode: 'Markdown',
                reply_to_message_id: msg.message_id
            });
        }
        
        const recipient = match[1].trim();
        const subject = match[2].trim();
        const htmlBody = match[3].trim();
        
        // Validate email format
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(recipient)) {
            return bot.sendMessage(chatId, '❌ Invalid email format. Please provide a valid email address.', {
                reply_to_message_id: msg.message_id
            });
        }
        
        try {
            // Send custom email using Resend API
            const result = await emailService.sendCustomEmail(recipient, subject, htmlBody);
            
            if (result.success) {
                const confirmation = `✅ **Email Sent Successfully**\n\n` +
                    `**To**: ${recipient}\n` +
                    `**Subject**: ${subject}\n` +
                    `**Message ID**: ${result.messageId || 'N/A'}\n` +
                    `**Sent At**: ${new Date().toLocaleString()}\n` +
                    `**Sent By**: ${msg.from.username ? `@${msg.from.username}` : msg.from.first_name}`;
                
                await bot.sendMessage(chatId, confirmation, {
                    parse_mode: 'Markdown',
                    reply_to_message_id: msg.message_id
                });
                console.log(`📧 Admin email sent by ${requesterId} to ${recipient}: "${subject}"`);
            } else {
                const error = result.offline ? 
                    '⚠️ Email service is offline (no API key configured)' : 
                    `❌ Failed to send: ${result.error}`;
                
                await bot.sendMessage(chatId, error, {
                    reply_to_message_id: msg.message_id
                });
            }
        } catch (error) {
            console.error('Send email error:', error);
            await bot.sendMessage(chatId, `❌ Error sending email: ${error.message}`, {
                reply_to_message_id: msg.message_id
            });
        }
        } catch (outerError) {
            console.error('[/sendemail] Outer error:', outerError);
        }
    });

    // Help command for email sending
    bot.onText(/\/help\s+email/i, async (msg) => {
        try {
            const chatId = msg.chat.id;
            const requesterId = msg.from.id.toString();
            
            if (!adminIds.includes(requesterId)) {
                return;  // Silently ignore non-admins
            }
        
        const helpText = `📧 **Admin Email Sending Command**\n\n` +
            `/sendemail <email> "<subject>" "<html_body>"\n\n` +
            `**Example:**\n` +
            `/sendemail user@example.com "Welcome to StarStore" "Hey there! Welcome to our platform."\n\n` +
            `**Features:**\n` +
            `✅ Full HTML support in email body\n` +
            `✅ Professional email template styling applied automatically\n` +
            `✅ Resend API integration for reliable delivery\n` +
            `✅ Admin audit logging of all emails sent\n\n` +
            `**Important:**\n` +
            `• Use double quotes for subject and body\n` +
            `• HTML is supported: use <b>, <i>, <p>, <br>, etc.\n` +
            `• Professional header/footer styling applied automatically\n` +
            `• Email sent from: noreply@starstore.site\n` +
            `• Reply-to: support@starstore.site`;
        
            await bot.sendMessage(chatId, helpText, {
                parse_mode: 'Markdown',
                reply_to_message_id: msg.message_id
            });
        } catch (error) {
            console.error('[Admin Commands] Help email command error:', error.message);
        }
    });

    console.log('[Admin Commands] Successfully registered /sendemail and /help email commands');
};
