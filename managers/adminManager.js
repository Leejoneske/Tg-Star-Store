const TelegramBot = require('node-telegram-bot-api');
const { User, BannedUser, Warning, BuyOrder, SellOrder } = require('../models');

class AdminManager {
    constructor(bot, adminIds) {
        this.bot = bot;
        this.adminIds = adminIds;
        this.setupAdminHandlers();
    }

    setupAdminHandlers() {
        // Admin commands
        this.bot.onText(/^\/(reverse|paysupport)(?:\s+(.+))?/i, async (msg, match) => {
            await this.handleReverseCommand(msg, match);
        });

        this.bot.onText(/^\/adminrefund (.+)/i, async (msg, match) => {
            await this.handleAdminRefund(msg, match);
        });

        this.bot.onText(/^\/refundtx (.+) (.+)/i, async (msg, match) => {
            await this.handleRefundTx(msg, match);
        });

        this.bot.onText(/^\/getpayment (.+)/i, async (msg, match) => {
            await this.handleGetPayment(msg, match);
        });

        this.bot.onText(/^\/findorder (.+)/i, async (msg, match) => {
            await this.handleFindOrder(msg, match);
        });

        this.bot.onText(/\/ban(?:\s+(\d+))$/, async (msg, match) => {
            await this.handleBanUser(msg, match);
        });

        this.bot.onText(/\/warn(?:\s+(\d+))$/, async (msg, match) => {
            await this.handleWarnUser(msg, match);
        });

        this.bot.onText(/\/unban (\d+)/, async (msg, match) => {
            await this.handleUnbanUser(msg, match);
        });

        this.bot.onText(/\/warnings (\d+)/, async (msg, match) => {
            await this.handleViewWarnings(msg, match);
        });

        this.bot.onText(/\/reply (\d+)(?:\s+(.+))?/, async (msg, match) => {
            await this.handleReplyToUser(msg, match);
        });

        this.bot.onText(/\/broadcast/, async (msg) => {
            await this.handleBroadcast(msg);
        });

        this.bot.onText(/\/notify(?:\s+(all|@\w+|\d+))?\s+(.+)/, async (msg, match) => {
            await this.handleNotify(msg, match);
        });

        this.bot.onText(/\/cso- (.+)/, async (msg, match) => {
            await this.handleCreateSellOrder(msg, match);
        });

        this.bot.onText(/\/cbo- (.+)/, async (msg, match) => {
            await this.handleCreateBuyOrder(msg, match);
        });

        this.bot.onText(/\/detect_users/, async (msg) => {
            await this.handleDetectUsers(msg);
        });

        this.bot.onText(/\/sell_complete (.+)/, async (msg, match) => {
            await this.handleSellComplete(msg, match);
        });

        this.bot.onText(/\/sell_decline (.+)/, async (msg, match) => {
            await this.handleSellDecline(msg, match);
        });

        this.bot.onText(/\/users/, async (msg) => {
            await this.handleListUsers(msg);
        });
    }

    async handleReverseCommand(msg, match) {
        if (!this.adminIds.includes(msg.from.id.toString())) {
            return;
        }

        const orderId = match[2] || '';
        if (!orderId) {
            await this.bot.sendMessage(msg.chat.id, "Usage: /reverse <order_id> or /paysupport <order_id>");
            return;
        }

        try {
            const order = await SellOrder.findOne({ id: orderId });
            if (!order) {
                await this.bot.sendMessage(msg.chat.id, "❌ Order not found");
                return;
            }

            if (order.status === "completed") {
                await this.bot.sendMessage(msg.chat.id, "❌ Order is already completed");
                return;
            }

            order.status = "reversed";
            order.dateCompleted = new Date();
            await order.save();

            await this.bot.sendMessage(msg.chat.id, `✅ Order ${orderId} has been reversed`);
        } catch (error) {
            console.error('Error reversing order:', error);
            await this.bot.sendMessage(msg.chat.id, "❌ Error reversing order");
        }
    }

    async handleAdminRefund(msg, match) {
        if (!this.adminIds.includes(msg.from.id.toString())) {
            return;
        }

        const orderId = match[1];
        try {
            const order = await SellOrder.findOne({ id: orderId });
            if (!order) {
                await this.bot.sendMessage(msg.chat.id, "❌ Order not found");
                return;
            }

            // Process refund logic here
            order.status = "refunded";
            order.dateCompleted = new Date();
            await order.save();

            await this.bot.sendMessage(msg.chat.id, `✅ Order ${orderId} has been refunded`);
        } catch (error) {
            console.error('Error refunding order:', error);
            await this.bot.sendMessage(msg.chat.id, "❌ Error refunding order");
        }
    }

    async handleRefundTx(msg, match) {
        if (!this.adminIds.includes(msg.from.id.toString())) {
            return;
        }

        const [orderId, txHash] = match.slice(1);
        try {
            const order = await SellOrder.findOne({ id: orderId });
            if (!order) {
                await this.bot.sendMessage(msg.chat.id, "❌ Order not found");
                return;
            }

            order.refundTxHash = txHash;
            order.status = "refunded";
            await order.save();

            await this.bot.sendMessage(msg.chat.id, `✅ Refund transaction hash added to order ${orderId}`);
        } catch (error) {
            console.error('Error adding refund tx:', error);
            await this.bot.sendMessage(msg.chat.id, "❌ Error adding refund transaction");
        }
    }

    async handleGetPayment(msg, match) {
        if (!this.adminIds.includes(msg.from.id.toString())) {
            return;
        }

        const orderId = match[1];
        try {
            const order = await SellOrder.findOne({ id: orderId });
            if (!order) {
                await this.bot.sendMessage(msg.chat.id, "❌ Order not found");
                return;
            }

            const message = `📋 Order Details:\n\n` +
                `ID: ${order.id}\n` +
                `User: ${order.username || 'Unknown'} (${order.telegramId})\n` +
                `Stars: ${order.stars}\n` +
                `Wallet: ${order.walletAddress}\n` +
                `Status: ${order.status}\n` +
                `Created: ${order.dateCreated}\n` +
                `Payment ID: ${order.telegram_payment_charge_id || 'N/A'}`;

            await this.bot.sendMessage(msg.chat.id, message);
        } catch (error) {
            console.error('Error getting payment details:', error);
            await this.bot.sendMessage(msg.chat.id, "❌ Error retrieving payment details");
        }
    }

    async handleFindOrder(msg, match) {
        if (!this.adminIds.includes(msg.from.id.toString())) {
            return;
        }

        const searchTerm = match[1];
        try {
            const order = await SellOrder.findOne({
                $or: [
                    { id: searchTerm },
                    { telegramId: searchTerm },
                    { username: searchTerm }
                ]
            });

            if (!order) {
                await this.bot.sendMessage(msg.chat.id, "❌ Order not found");
                return;
            }

            const message = `🔍 Order Found:\n\n` +
                `ID: ${order.id}\n` +
                `User: ${order.username || 'Unknown'} (${order.telegramId})\n` +
                `Stars: ${order.stars}\n` +
                `Status: ${order.status}\n` +
                `Created: ${order.dateCreated}`;

            await this.bot.sendMessage(msg.chat.id, message);
        } catch (error) {
            console.error('Error finding order:', error);
            await this.bot.sendMessage(msg.chat.id, "❌ Error finding order");
        }
    }

    async handleBanUser(msg, match) {
        if (!this.adminIds.includes(msg.from.id.toString())) {
            return;
        }

        const userId = match[1];
        if (!userId) {
            await this.bot.sendMessage(msg.chat.id, "Usage: /ban <user_id>");
            return;
        }

        try {
            const existingBan = await BannedUser.findOne({ userId });
            if (existingBan) {
                await this.bot.sendMessage(msg.chat.id, "❌ User is already banned");
                return;
            }

            const bannedUser = new BannedUser({
                userId,
                bannedBy: msg.from.id,
                reason: "Admin ban",
                dateBanned: new Date()
            });
            await bannedUser.save();

            await this.bot.sendMessage(msg.chat.id, `✅ User ${userId} has been banned`);
        } catch (error) {
            console.error('Error banning user:', error);
            await this.bot.sendMessage(msg.chat.id, "❌ Error banning user");
        }
    }

    async handleWarnUser(msg, match) {
        if (!this.adminIds.includes(msg.from.id.toString())) {
            return;
        }

        const userId = match[1];
        if (!userId) {
            await this.bot.sendMessage(msg.chat.id, "Usage: /warn <user_id>");
            return;
        }

        try {
            const warning = new Warning({
                userId,
                warnedBy: msg.from.id,
                reason: "Admin warning",
                dateWarned: new Date()
            });
            await warning.save();

            await this.bot.sendMessage(msg.chat.id, `⚠️ User ${userId} has been warned`);
        } catch (error) {
            console.error('Error warning user:', error);
            await this.bot.sendMessage(msg.chat.id, "❌ Error warning user");
        }
    }

    async handleUnbanUser(msg, match) {
        if (!this.adminIds.includes(msg.from.id.toString())) {
            return;
        }

        const userId = match[1];
        try {
            const bannedUser = await BannedUser.findOne({ userId });
            if (!bannedUser) {
                await this.bot.sendMessage(msg.chat.id, "❌ User is not banned");
                return;
            }

            await BannedUser.deleteOne({ userId });
            await this.bot.sendMessage(msg.chat.id, `✅ User ${userId} has been unbanned`);
        } catch (error) {
            console.error('Error unbanning user:', error);
            await this.bot.sendMessage(msg.chat.id, "❌ Error unbanning user");
        }
    }

    async handleViewWarnings(msg, match) {
        if (!this.adminIds.includes(msg.from.id.toString())) {
            return;
        }

        const userId = match[1];
        try {
            const warnings = await Warning.find({ userId }).sort({ dateWarned: -1 });
            if (warnings.length === 0) {
                await this.bot.sendMessage(msg.chat.id, `📋 User ${userId} has no warnings`);
                return;
            }

            let message = `📋 Warnings for user ${userId}:\n\n`;
            warnings.forEach((warning, index) => {
                message += `${index + 1}. ${warning.reason} - ${warning.dateWarned.toLocaleDateString()}\n`;
            });

            await this.bot.sendMessage(msg.chat.id, message);
        } catch (error) {
            console.error('Error viewing warnings:', error);
            await this.bot.sendMessage(msg.chat.id, "❌ Error viewing warnings");
        }
    }

    async handleReplyToUser(msg, match) {
        if (!this.adminIds.includes(msg.from.id.toString())) {
            return;
        }

        const [userId, replyText] = match.slice(1);
        if (!userId || !replyText) {
            await this.bot.sendMessage(msg.chat.id, "Usage: /reply <user_id> <message>");
            return;
        }

        try {
            await this.bot.sendMessage(userId, `💬 Admin Reply:\n\n${replyText}`);
            await this.bot.sendMessage(msg.chat.id, `✅ Reply sent to user ${userId}`);
        } catch (error) {
            console.error('Error sending reply:', error);
            await this.bot.sendMessage(msg.chat.id, "❌ Error sending reply");
        }
    }

    async handleBroadcast(msg) {
        if (!this.adminIds.includes(msg.from.id.toString())) {
            return;
        }

        await this.bot.sendMessage(msg.chat.id, "📢 Enter your broadcast message:");
        this.bot.once('message', async (adminMsg) => {
            if (adminMsg.from.id.toString() !== msg.from.id.toString()) return;

            try {
                const users = await User.find({});
                let sentCount = 0;
                let failedCount = 0;

                for (const user of users) {
                    try {
                        await this.bot.sendMessage(user.id, `📢 Broadcast:\n\n${adminMsg.text}`);
                        sentCount++;
                    } catch (error) {
                        failedCount++;
                    }
                }

                await this.bot.sendMessage(msg.chat.id, 
                    `📢 Broadcast completed!\n\n` +
                    `✅ Sent: ${sentCount}\n` +
                    `❌ Failed: ${failedCount}`
                );
            } catch (error) {
                console.error('Error broadcasting:', error);
                await this.bot.sendMessage(msg.chat.id, "❌ Error sending broadcast");
            }
        });
    }

    async handleNotify(msg, match) {
        if (!this.adminIds.includes(msg.from.id.toString())) {
            return;
        }

        const [target, message] = match.slice(1);
        try {
            let sentCount = 0;
            let failedCount = 0;

            if (target === 'all') {
                const users = await User.find({});
                for (const user of users) {
                    try {
                        await this.bot.sendMessage(user.id, `🔔 Notification:\n\n${message}`);
                        sentCount++;
                    } catch (error) {
                        failedCount++;
                    }
                }
            } else if (target.startsWith('@')) {
                const username = target.substring(1);
                const user = await User.findOne({ username });
                if (user) {
                    await this.bot.sendMessage(user.id, `🔔 Notification:\n\n${message}`);
                    sentCount = 1;
                } else {
                    failedCount = 1;
                }
            } else {
                await this.bot.sendMessage(target, `🔔 Notification:\n\n${message}`);
                sentCount = 1;
            }

            await this.bot.sendMessage(msg.chat.id, 
                `🔔 Notification sent!\n\n` +
                `✅ Sent: ${sentCount}\n` +
                `❌ Failed: ${failedCount}`
            );
        } catch (error) {
            console.error('Error sending notification:', error);
            await this.bot.sendMessage(msg.chat.id, "❌ Error sending notification");
        }
    }

    async handleCreateSellOrder(msg, match) {
        if (!this.adminIds.includes(msg.from.id.toString())) {
            return;
        }

        const orderData = match[1];
        // Implementation for creating sell order
        await this.bot.sendMessage(msg.chat.id, "Creating sell order...");
    }

    async handleCreateBuyOrder(msg, match) {
        if (!this.adminIds.includes(msg.from.id.toString())) {
            return;
        }

        const orderData = match[1];
        // Implementation for creating buy order
        await this.bot.sendMessage(msg.chat.id, "Creating buy order...");
    }

    async handleDetectUsers(msg) {
        if (!this.adminIds.includes(msg.from.id.toString())) {
            return;
        }

        try {
            const users = await User.find({});
            await this.bot.sendMessage(msg.chat.id, `📊 Total users detected: ${users.length}`);
        } catch (error) {
            console.error('Error detecting users:', error);
            await this.bot.sendMessage(msg.chat.id, "❌ Error detecting users");
        }
    }

    async handleSellComplete(msg, match) {
        if (!this.adminIds.includes(msg.from.id.toString())) {
            return;
        }

        const orderId = match[1];
        try {
            const order = await SellOrder.findOne({ id: orderId });
            if (!order) {
                await this.bot.sendMessage(msg.chat.id, "❌ Order not found");
                return;
            }

            order.status = "completed";
            order.dateCompleted = new Date();
            await order.save();

            await this.bot.sendMessage(msg.chat.id, `✅ Order ${orderId} marked as completed`);
        } catch (error) {
            console.error('Error completing order:', error);
            await this.bot.sendMessage(msg.chat.id, "❌ Error completing order");
        }
    }

    async handleSellDecline(msg, match) {
        if (!this.adminIds.includes(msg.from.id.toString())) {
            return;
        }

        const orderId = match[1];
        try {
            const order = await SellOrder.findOne({ id: orderId });
            if (!order) {
                await this.bot.sendMessage(msg.chat.id, "❌ Order not found");
                return;
            }

            order.status = "declined";
            order.dateCompleted = new Date();
            await order.save();

            await this.bot.sendMessage(msg.chat.id, `❌ Order ${orderId} marked as declined`);
        } catch (error) {
            console.error('Error declining order:', error);
            await this.bot.sendMessage(msg.chat.id, "❌ Error declining order");
        }
    }

    async handleListUsers(msg) {
        if (!this.adminIds.includes(msg.from.id.toString())) {
            return;
        }

        try {
            const users = await User.find({}).sort({ dateCreated: -1 }).limit(10);
            let message = "📊 Recent Users:\n\n";
            
            users.forEach((user, index) => {
                message += `${index + 1}. ${user.username || 'Unknown'} (${user.id})\n`;
            });

            await this.bot.sendMessage(msg.chat.id, message);
        } catch (error) {
            console.error('Error listing users:', error);
            await this.bot.sendMessage(msg.chat.id, "❌ Error listing users");
        }
    }
}

module.exports = AdminManager;