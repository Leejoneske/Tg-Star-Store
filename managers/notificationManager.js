const TelegramBot = require('node-telegram-bot-api');
const { Notification, User } = require('../models');

class NotificationManager {
    constructor(bot, adminIds) {
        this.bot = bot;
        this.adminIds = adminIds;
        this.notificationTypes = {
            ORDER_COMPLETED: 'order_completed',
            ORDER_CANCELLED: 'order_cancelled',
            PAYMENT_RECEIVED: 'payment_received',
            REFUND_PROCESSED: 'refund_processed',
            REFERRAL_ACTIVATED: 'referral_activated',
            SYSTEM_MAINTENANCE: 'system_maintenance',
            NEW_FEATURE: 'new_feature',
            SECURITY_ALERT: 'security_alert',
            WELCOME: 'welcome',
            REMINDER: 'reminder'
        };
        
        this.setupNotificationHandlers();
        this.startAutomaticNotifications();
    }

    setupNotificationHandlers() {
        // Admin commands for notification management
        this.bot.onText(/\/send_notification (.+)/, async (msg, match) => {
            await this.handleSendNotification(msg, match);
        });

        this.bot.onText(/\/send_global_notification (.+)/, async (msg, match) => {
            await this.handleSendGlobalNotification(msg, match);
        });

        this.bot.onText(/\/notification_stats/, async (msg) => {
            await this.handleNotificationStats(msg);
        });
    }

    async handleSendNotification(msg, match) {
        if (!this.adminIds.includes(msg.from.id.toString())) {
            return this.bot.sendMessage(msg.chat.id, '⛔ **Access Denied**\n\nInsufficient privileges to execute this command.', {
                parse_mode: 'Markdown',
                reply_to_message_id: msg.message_id
            });
        }

        const notificationData = match[1].trim();
        const parts = notificationData.split('|');
        
        if (parts.length < 3) {
            return this.bot.sendMessage(msg.chat.id, 
                '❌ **Invalid Format**\n\n' +
                'Usage: `/send_notification userId|title|message`\n\n' +
                'Example: `/send_notification 123456789|Order Update|Your order has been processed`', {
                parse_mode: 'Markdown',
                reply_to_message_id: msg.message_id
            });
        }

        const [userId, title, message] = parts;
        
        try {
            const user = await User.findOne({ $or: [{ id: userId }, { telegramId: userId }] });
            if (!user) {
                return this.bot.sendMessage(msg.chat.id, `❌ User ${userId} not found in database.`, {
                    reply_to_message_id: msg.message_id
                });
            }

            const notification = await this.createNotification({
                userId: userId,
                title: title,
                message: message,
                type: 'manual',
                createdBy: msg.from.id.toString()
            });

            // Send Telegram notification
            try {
                const telegramMessage = `🔔 **${title}**\n\n${message}\n\n📅 ${new Date().toLocaleString()}`;
                await this.bot.sendMessage(parseInt(userId), telegramMessage, { parse_mode: 'Markdown' });
            } catch (telegramError) {
                console.error('Failed to send Telegram notification:', telegramError);
            }

            await this.bot.sendMessage(msg.chat.id, 
                `✅ **Notification Sent**\n\n` +
                `**User**: @${user.username}\n` +
                `**Title**: ${title}\n` +
                `**Message**: ${message}\n` +
                `**Status**: Delivered`, {
                parse_mode: 'Markdown',
                reply_to_message_id: msg.message_id
            });

        } catch (error) {
            console.error('Error sending notification:', error);
            await this.bot.sendMessage(msg.chat.id, `❌ Error sending notification: ${error.message}`, {
                reply_to_message_id: msg.message_id
            });
        }
    }

    async handleSendGlobalNotification(msg, match) {
        if (!this.adminIds.includes(msg.from.id.toString())) {
            return this.bot.sendMessage(msg.chat.id, '⛔ **Access Denied**\n\nInsufficient privileges to execute this command.', {
                parse_mode: 'Markdown',
                reply_to_message_id: msg.message_id
            });
        }

        const notificationData = match[1].trim();
        const parts = notificationData.split('|');
        
        if (parts.length < 2) {
            return this.bot.sendMessage(msg.chat.id, 
                '❌ **Invalid Format**\n\n' +
                'Usage: `/send_global_notification title|message`\n\n' +
                'Example: `/send_global_notification System Update|We will be performing maintenance tonight`', {
                parse_mode: 'Markdown',
                reply_to_message_id: msg.message_id
            });
        }

        const [title, message] = parts;
        
        try {
            const notification = await this.createNotification({
                userId: 'all',
                title: title,
                message: message,
                type: 'global',
                isGlobal: true,
                priority: 1,
                createdBy: msg.from.id.toString()
            });

            // Get all users and send Telegram notifications
            const users = await User.find({});
            let successCount = 0;
            let failCount = 0;

            for (const user of users) {
                try {
                    const telegramMessage = `🔔 **${title}**\n\n${message}\n\n📅 ${new Date().toLocaleString()}`;
                    await this.bot.sendMessage(parseInt(user.id || user.telegramId), telegramMessage, { parse_mode: 'Markdown' });
                    successCount++;
                } catch (telegramError) {
                    failCount++;
                    console.error(`Failed to send global notification to ${user.id}:`, telegramError);
                }
                
                // Small delay to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 100));
            }

            await this.bot.sendMessage(msg.chat.id, 
                `✅ **Global Notification Sent**\n\n` +
                `**Title**: ${title}\n` +
                `**Message**: ${message}\n` +
                `**Recipients**: ${users.length}\n` +
                `**✅ Success**: ${successCount}\n` +
                `**❌ Failed**: ${failCount}`, {
                parse_mode: 'Markdown',
                reply_to_message_id: msg.message_id
            });

        } catch (error) {
            console.error('Error sending global notification:', error);
            await this.bot.sendMessage(msg.chat.id, `❌ Error sending global notification: ${error.message}`, {
                reply_to_message_id: msg.message_id
            });
        }
    }

    async handleNotificationStats(msg) {
        if (!this.adminIds.includes(msg.from.id.toString())) {
            return this.bot.sendMessage(msg.chat.id, '⛔ **Access Denied**\n\nInsufficient privileges to execute this command.', {
                parse_mode: 'Markdown',
                reply_to_message_id: msg.message_id
            });
        }

        try {
            const totalNotifications = await Notification.countDocuments();
            const unreadNotifications = await Notification.countDocuments({ read: false });
            const globalNotifications = await Notification.countDocuments({ isGlobal: true });
            const todayNotifications = await Notification.countDocuments({
                timestamp: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) }
            });

            const stats = `📊 **Notification Statistics**\n\n` +
                `**Total Notifications**: ${totalNotifications}\n` +
                `**Unread Notifications**: ${unreadNotifications}\n` +
                `**Global Notifications**: ${globalNotifications}\n` +
                `**Today's Notifications**: ${todayNotifications}\n\n` +
                `**Read Rate**: ${totalNotifications > 0 ? ((totalNotifications - unreadNotifications) / totalNotifications * 100).toFixed(1) : 0}%`;

            await this.bot.sendMessage(msg.chat.id, stats, {
                parse_mode: 'Markdown',
                reply_to_message_id: msg.message_id
            });

        } catch (error) {
            console.error('Error getting notification stats:', error);
            await this.bot.sendMessage(msg.chat.id, `❌ Error getting notification stats: ${error.message}`, {
                reply_to_message_id: msg.message_id
            });
        }
    }

    async createNotification(data) {
        const notification = new Notification({
            userId: data.userId,
            title: data.title,
            message: data.message,
            actionUrl: data.actionUrl,
            icon: this.getIconForType(data.type),
            isGlobal: data.isGlobal || false,
            read: false,
            createdBy: data.createdBy || 'system',
            priority: data.priority || 0,
            type: data.type || 'system'
        });

        await notification.save();
        return notification;
    }

    getIconForType(type) {
        const iconMap = {
            'order_completed': 'fa-check-circle',
            'order_cancelled': 'fa-times-circle',
            'payment_received': 'fa-credit-card',
            'refund_processed': 'fa-undo',
            'referral_activated': 'fa-users',
            'system_maintenance': 'fa-tools',
            'new_feature': 'fa-star',
            'security_alert': 'fa-shield-alt',
            'welcome': 'fa-gift',
            'reminder': 'fa-clock',
            'manual': 'fa-bell',
            'global': 'fa-broadcast-tower',
            'system': 'fa-cog'
        };
        return iconMap[type] || 'fa-bell';
    }

    // Automatic notification methods
    async sendOrderCompletedNotification(userId, orderId, stars) {
        const notification = await this.createNotification({
            userId: userId,
            title: 'Order Completed',
            message: `Your order #${orderId} for ${stars} stars has been completed successfully.`,
            type: this.notificationTypes.ORDER_COMPLETED,
            actionUrl: `/orders/${orderId}`,
            priority: 1
        });

        // Send Telegram notification
        try {
            const message = `✅ **Order Completed!**\n\n` +
                `**Order ID**: ${orderId}\n` +
                `**Stars**: ${stars}\n` +
                `**Status**: Completed\n\n` +
                `Your order has been processed successfully.`;
            
            await this.bot.sendMessage(parseInt(userId), message, { parse_mode: 'Markdown' });
        } catch (error) {
            console.error('Failed to send order completion Telegram notification:', error);
        }

        return notification;
    }

    async sendPaymentReceivedNotification(userId, orderId, amount) {
        const notification = await this.createNotification({
            userId: userId,
            title: 'Payment Received',
            message: `Payment of $${amount} received for order #${orderId}. Your order is now being processed.`,
            type: this.notificationTypes.PAYMENT_RECEIVED,
            actionUrl: `/orders/${orderId}`,
            priority: 1
        });

        return notification;
    }

    async sendRefundProcessedNotification(userId, orderId, amount) {
        const notification = await this.createNotification({
            userId: userId,
            title: 'Refund Processed',
            message: `Refund of $${amount} for order #${orderId} has been processed.`,
            type: this.notificationTypes.REFUND_PROCESSED,
            actionUrl: `/orders/${orderId}`,
            priority: 1
        });

        return notification;
    }

    async sendReferralActivatedNotification(userId, referrerId) {
        const notification = await this.createNotification({
            userId: userId,
            title: 'Referral Activated',
            message: 'Your referral has been activated! You now qualify for referral rewards.',
            type: this.notificationTypes.REFERRAL_ACTIVATED,
            actionUrl: '/referrals',
            priority: 1
        });

        return notification;
    }

    async sendWelcomeNotification(userId) {
        const notification = await this.createNotification({
            userId: userId,
            title: 'Welcome to StarStore!',
            message: 'Thank you for joining StarStore! Start buying and selling Telegram stars today.',
            type: this.notificationTypes.WELCOME,
            actionUrl: '/',
            priority: 0
        });

        return notification;
    }

    async sendSystemMaintenanceNotification(message, isGlobal = true) {
        const notification = await this.createNotification({
            userId: isGlobal ? 'all' : null,
            title: 'System Maintenance',
            message: message,
            type: this.notificationTypes.SYSTEM_MAINTENANCE,
            isGlobal: isGlobal,
            priority: 2
        });

        return notification;
    }

    async sendNewFeatureNotification(featureName, description, isGlobal = true) {
        const notification = await this.createNotification({
            userId: isGlobal ? 'all' : null,
            title: `New Feature: ${featureName}`,
            message: description,
            type: this.notificationTypes.NEW_FEATURE,
            isGlobal: isGlobal,
            priority: 1
        });

        return notification;
    }

    async sendSecurityAlertNotification(message, isGlobal = true) {
        const notification = await this.createNotification({
            userId: isGlobal ? 'all' : null,
            title: 'Security Alert',
            message: message,
            type: this.notificationTypes.SECURITY_ALERT,
            isGlobal: isGlobal,
            priority: 2
        });

        return notification;
    }

    // Automatic notification scheduling
    startAutomaticNotifications() {
        // Send welcome notifications for new users (handled in UserInteractionManager)
        // Send daily reminders (if needed)
        // Send system maintenance notifications
        // Send new feature announcements
        
        console.log('🔔 Automatic notification system started');
    }

    // Utility methods
    async markAsRead(notificationId, userId) {
        return await Notification.updateOne(
            { _id: notificationId, $or: [{ userId: 'all' }, { userId: userId }, { isGlobal: true }] },
            { read: true }
        );
    }

    async markAllAsRead(userId) {
        return await Notification.updateMany(
            { 
                $or: [{ userId: 'all' }, { userId: userId }, { isGlobal: true }],
                read: false 
            },
            { read: true }
        );
    }

    async getUnreadCount(userId) {
        return await Notification.countDocuments({
            $or: [{ userId: 'all' }, { userId: userId }, { isGlobal: true }],
            read: false
        });
    }

    async getUserNotifications(userId, limit = 20, skip = 0) {
        return await Notification.find({
            $or: [{ userId: 'all' }, { userId: userId }, { isGlobal: true }]
        })
        .sort({ priority: -1, timestamp: -1 })
        .skip(skip)
        .limit(limit)
        .lean();
    }
}

module.exports = NotificationManager;