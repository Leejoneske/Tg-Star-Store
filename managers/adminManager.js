const TelegramBot = require('node-telegram-bot-api');
const { User, BannedUser, Warning, BuyOrder, SellOrder, Reversal } = require('../models');
const axios = require('axios');

class AdminManager {
    constructor(bot, adminIds) {
        this.bot = bot;
        this.adminIds = adminIds;
        this.reversalRequests = new Map();
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

        // Enhanced message handler for refund requests
        this.bot.on('message', async (msg) => {
            await this.handleRefundMessages(msg);
        });
    }

    async handleReverseCommand(msg, match) {
        const chatId = msg.chat.id;
        const userId = chatId.toString();
        
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        
        const recentRequest = await Reversal.findOne({
            telegramId: userId,
            createdAt: { $gte: thirtyDaysAgo },
            status: { $in: ['pending', 'processing'] }
        });
        
        if (recentRequest) {
            const nextAllowedDate = new Date(recentRequest.createdAt);
            nextAllowedDate.setDate(nextAllowedDate.getDate() + 30);
            return this.bot.sendMessage(chatId, 
                `❌ You can only request one refund per month.\n` +
                `Next refund available: ${nextAllowedDate.toDateString()}`
            );
        }
        
        const orderId = match[2] ? match[2].trim() : null;
        
        if (!orderId) {
            const welcomeMsg = `🔄 Welcome to Sell Order Pay Support\n\n` +
                `You are about to request a cancellation and refund for your order. ` +
                `Please note that refund requests are limited to once per month.\n\n` +
                `Please enter your Order ID:`;
            
            this.reversalRequests.set(chatId, { 
                step: 'waiting_order_id', 
                timestamp: Date.now() 
            });
            return this.bot.sendMessage(chatId, welcomeMsg);
        }
        
        const order = await SellOrder.findOne({ id: orderId, telegramId: userId });
        
        if (!order) return this.bot.sendMessage(chatId, "❌ Order not found or doesn't belong to you");
        if (order.status !== 'processing') return this.bot.sendMessage(chatId, `❌ Order is ${order.status} - cannot be reversed`);
        
        this.reversalRequests.set(chatId, { 
            step: 'waiting_reason',
            orderId, 
            timestamp: Date.now() 
        });
        this.bot.sendMessage(chatId, 
            `📋 Order Found: ${orderId}\n` +
            `Stars: ${order.stars}\n\n` +
            `Please provide a detailed explanation (minimum 10 words) for why you need to reverse this order:`
        );
    }

    async handleRefundMessages(msg) {
        const chatId = msg.chat.id;
        const userId = chatId.toString();
        const request = this.reversalRequests.get(chatId);
        if (!request || !msg.text || msg.text.startsWith('/')) return;
        
        if (Date.now() - request.timestamp > 300000) {
            this.reversalRequests.delete(chatId);
            return this.bot.sendMessage(chatId, "⌛ Session expired. Please start over with /reverse or /paysupport");
        }

        if (request.step === 'waiting_order_id') {
            const orderId = msg.text.trim();
            const order = await SellOrder.findOne({ id: orderId, telegramId: userId });
            
            if (!order) {
                return this.bot.sendMessage(chatId, "❌ Order not found or doesn't belong to you. Please enter a valid Order ID:");
            }
            if (order.status !== 'processing') {
                return this.bot.sendMessage(chatId, `❌ Order ${orderId} is ${order.status} - cannot be reversed. Please enter a different Order ID:`);
            }
            
            request.step = 'waiting_reason';
            request.orderId = orderId;
            request.timestamp = Date.now();
            this.reversalRequests.set(chatId, request);
            
            return this.bot.sendMessage(chatId, 
                `📋 Order Found: ${orderId}\n` +
                `Stars: ${order.stars}\n\n` +
                `Please provide a detailed explanation (minimum 10 words) for why you need to reverse this order:`
            );
        }

        if (request.step === 'waiting_reason') {
            const reason = msg.text.trim();
            const wordCount = reason.split(/\s+/).filter(word => word.length > 0).length;
            
            if (wordCount < 10) {
                return this.bot.sendMessage(chatId, 
                    `❌ Please provide a more detailed reason (minimum 10 words). Current: ${wordCount} words.\n` +
                    `Please explain in detail why you need this refund:`
                );
            }

            const order = await SellOrder.findOne({ id: request.orderId });
            const requestDoc = new Reversal({
                orderId: request.orderId,
                telegramId: userId,
                username: msg.from.username || `${msg.from.first_name}${msg.from.last_name ? ' ' + msg.from.last_name : ''}`,
                stars: order.stars,
                reason: reason,
                status: 'pending'
            });
            await requestDoc.save();

            const safeUsername = requestDoc.username.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
            const safeReason = reason.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
            
            const adminMsg = `🔄 Reversal Request\n` +
                `Order: ${request.orderId}\n` +
                `User: @${safeUsername}\n` +
                `User ID: ${userId}\n` +
                `Stars: ${order.stars}\n` +
                `Reason: ${safeReason}`;
            
            for (const adminId of this.adminIds) {
                try {
                    const message = await this.bot.sendMessage(parseInt(adminId), adminMsg, {
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    { text: "✅ Approve", callback_data: `req_approve_${request.orderId}` },
                                    { text: "❌ Reject", callback_data: `req_reject_${request.orderId}` }
                                ]
                            ]
                        },
                        parse_mode: 'MarkdownV2'
                    });
                    requestDoc.adminMessages.push({ 
                        adminId: adminId, 
                        messageId: message.message_id,
                        messageType: 'refund'
                    });
                } catch (err) {
                    console.error(`Failed to send to admin ${adminId}:`, err.message);
                }
            }
            await requestDoc.save();
            this.bot.sendMessage(chatId, `📨 Reversal request submitted for order ${request.orderId}\nYou will be notified once reviewed.`);
            this.reversalRequests.delete(chatId);
        }
    }

    async handleAdminRefund(msg, match) {
        const chatId = msg.chat.id;
        if (!this.adminIds.includes(chatId.toString())) return this.bot.sendMessage(chatId, "❌ Access denied");
        
        const txId = match[1].trim();
        const order = await SellOrder.findOne({ telegram_payment_charge_id: txId });
        
        if (!order) return this.bot.sendMessage(chatId, "❌ Order not found with this TX ID");
        if (order.status === 'refunded') return this.bot.sendMessage(chatId, "❌ Order already refunded");
        
        try {
            const result = await this.processRefund(order.id);
            
            if (result.success) {
                const statusMessage = result.alreadyRefunded 
                    ? `✅ Order ${order.id} was already refunded\nCharge ID: ${result.chargeId}`
                    : `✅ Admin refund processed for order ${order.id}\nCharge ID: ${result.chargeId}`;
                
                await this.bot.sendMessage(chatId, statusMessage);
                
                try {
                    const userMessage = result.alreadyRefunded
                        ? `💸 Your refund for order ${order.id} was already processed\nTX ID: ${result.chargeId}`
                        : `💸 Refund Processed by Admin\nOrder: ${order.id}\nTX ID: ${result.chargeId}`;
                    
                    await this.bot.sendMessage(parseInt(order.telegramId), userMessage);
                } catch (userError) {
                    await this.bot.sendMessage(chatId, `⚠️ Refund processed but user notification failed`);
                }
            }
        } catch (error) {
            await this.bot.sendMessage(chatId, `❌ Admin refund failed for ${order.id}\nError: ${error.message}`);
        }
    }

    async handleRefundTx(msg, match) {
        const chatId = msg.chat.id;
        if (!this.adminIds.includes(chatId.toString())) return this.bot.sendMessage(chatId, "❌ Access denied");
        
        const txId = match[1].trim();
        const userId = match[2].trim();
        
        try {
            const refundPayload = {
                user_id: parseInt(userId),
                telegram_payment_charge_id: txId
            };

            const { data } = await axios.post(
                `https://api.telegram.org/bot${process.env.BOT_TOKEN}/refundStarPayment`,
                refundPayload,
                { 
                    timeout: 15000,
                    headers: {
                        'Content-Type': 'application/json'
                    }
                }
            );

            if (!data.ok) {
                if (data.description && data.description.includes('CHARGE_ALREADY_REFUNDED')) {
                    return this.bot.sendMessage(chatId, `✅ TX ${txId} was already refunded`);
                }
                throw new Error(data.description || "Refund API call failed");
            }

            const order = await SellOrder.findOne({ telegram_payment_charge_id: txId });
            if (order) {
                order.status = 'refunded';
                order.dateRefunded = new Date();
                order.refundData = {
                    requested: true,
                    status: 'processed',
                    processedAt: new Date(),
                    chargeId: txId
                };
                await order.save();
            }

            try {
                await this.bot.sendMessage(
                    parseInt(userId),
                    `💸 Refund Processed by Admin\nTX ID: ${txId}`
                );
            } catch (userError) {}

            await this.bot.sendMessage(chatId, `✅ Direct refund processed for TX: ${txId}\nUser: ${userId}`);

        } catch (error) {
            await this.bot.sendMessage(chatId, `❌ Direct refund failed for TX ${txId}\nError: ${error.message}`);
        }
    }

    async processRefund(orderId) {
        const session = await require('mongoose').startSession();
        session.startTransaction();

        try {
            const order = await SellOrder.findOne({ id: orderId }).session(session);
            if (!order) throw new Error("Order not found");
            if (order.status !== 'processing') throw new Error("Order not in processing state");
            if (!order.telegram_payment_charge_id) throw new Error("Missing payment reference");

            const refundPayload = {
                user_id: parseInt(order.telegramId),
                telegram_payment_charge_id: order.telegram_payment_charge_id
            };

            const { data } = await axios.post(
                `https://api.telegram.org/bot${process.env.BOT_TOKEN}/refundStarPayment`,
                refundPayload,
                { 
                    timeout: 15000,
                    headers: {
                        'Content-Type': 'application/json'
                    }
                }
            );

            if (!data.ok) {
                if (data.description && data.description.includes('CHARGE_ALREADY_REFUNDED')) {
                    order.status = 'refunded';
                    order.dateRefunded = new Date();
                    order.refundData = {
                        requested: true,
                        status: 'refunded',
                        processedAt: new Date(),
                        chargeId: order.telegram_payment_charge_id
                    };
                    await order.save({ session });
                    await session.commitTransaction();
                    return { success: true, chargeId: order.telegram_payment_charge_id, alreadyRefunded: true };
                }
                throw new Error(data.description || "Refund API call failed");
            }

            order.status = 'refunded';
            order.dateRefunded = new Date();
            order.refundData = {
                requested: true,
                status: 'refunded',
                processedAt: new Date(),
                chargeId: order.telegram_payment_charge_id
            };
            await order.save({ session });
            await session.commitTransaction();
            return { success: true, chargeId: order.telegram_payment_charge_id };

        } catch (error) {
            await session.abortTransaction();
            console.error('Refund processing error:', error.message);
            throw error;
        } finally {
            session.endSession();
        }
    }

    async updateAdminMessages(request, statusText) {
        if (!request.adminMessages || request.adminMessages.length === 0) return;
        
        for (const msg of request.adminMessages) {
            try {
                await this.bot.editMessageReplyMarkup(
                    { inline_keyboard: [[{ text: statusText, callback_data: 'processed_done' }]] },
                    { chat_id: parseInt(msg.adminId), message_id: msg.messageId }
                );
            } catch (err) {
                console.error(`Failed to update admin message for ${msg.adminId}:`, err.message);
            }
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
            return this.bot.sendMessage(msg.chat.id, '⛔ **Access Denied**\n\nInsufficient privileges to execute this command.', {
                parse_mode: 'Markdown',
                reply_to_message_id: msg.message_id
            });
        }
        
        if (!match[1]) return;
        
        const userId = match[1];
        const existing = await Warning.findOne({ userId: userId, type: 'ban', isActive: true });
        if (existing) {
            return this.bot.sendMessage(msg.chat.id, `⚠️ User ${userId} is already banned.`, {
                reply_to_message_id: msg.message_id
            });
        }
        
        await Warning.create({
            userId: userId,
            type: 'ban',
            reason: 'Policy violation',
            issuedBy: msg.from.id.toString(),
            isActive: true,
            autoRemove: false
        });
        
        await BannedUser.updateOne(
            {}, 
            { $push: { users: userId } },
            { upsert: true }
        );
        
        try {
            const userSuspensionNotice = `**ACCOUNT NOTICE**\n\n` +
                `We've detected unusual account activities that violate our terms of service.\n\n` +
                `**Account Status**: Temporarily Restricted\n` +
                `**Effective Date**: ${new Date().toLocaleDateString()}\n\n` +
                `During this time, you will not be able to place orders until the restriction period ends.\n\n` +
                `If you believe this is an error, please contact our support team.`;
            
            await this.bot.sendMessage(userId, userSuspensionNotice, { parse_mode: 'Markdown' });
        } catch (error) {
            console.error('Suspension notification delivery failed:', error);
        }
        
        const adminSummary = `✅ **Account Ban Applied**\n\n` +
            `**Target Account**: ${userId}\n` +
            `**Suspension Type**: Indefinite\n` +
            `**Reason**: Rule violation\n` +
            `**Authorized By**: ${msg.from.username ? `@${msg.from.username}` : msg.from.first_name}\n` +
            `**Timestamp**: ${new Date().toLocaleString()}`;
        
        await this.bot.sendMessage(msg.chat.id, adminSummary, {
            parse_mode: 'Markdown',
            reply_to_message_id: msg.message_id
        });
    }

    async handleWarnUser(msg, match) {
        if (!this.adminIds.includes(msg.from.id.toString())) {
            return this.bot.sendMessage(msg.chat.id, '⛔ **Access Denied**\n\nInsufficient privileges to execute this command.', {
                parse_mode: 'Markdown',
                reply_to_message_id: msg.message_id
            });
        }
        
        if (!match[1]) return;
        
        const userId = match[1];
        
        const expirationDate = new Date();
        expirationDate.setDate(expirationDate.getDate() + 2);
        
        await Warning.create({
            userId: userId,
            type: 'warning',
            reason: 'Minor policy violation',
            issuedBy: msg.from.id.toString(),
            expiresAt: expirationDate,
            isActive: true,
            autoRemove: true
        });
        
        await BannedUser.updateOne(
            {}, 
            { $push: { users: userId } },
            { upsert: true }
        );
        
        try {
            const userWarningNotice = `**ACCOUNT NOTICE**\n\n` +
                `We've detected unusual account activities that require attention.\n\n` +
                `**Account Status**: Temporarily Restricted\n` +
                `**Effective Date**: ${new Date().toLocaleDateString()}\n\n` +
                `During this time, you will not be able to place orders until the restriction period ends.\n\n` +
                `If you believe this is an error, please contact our support team.`;
            
            await this.bot.sendMessage(userId, userWarningNotice, { parse_mode: 'Markdown' });
        } catch (error) {
            console.error('Warning notification delivery failed:', error);
        }
        
        const adminSummary = `⚠️ **Temporary Ban Applied**\n\n` +
            `**Target Account**: ${userId}\n` +
            `**Restriction Type**: Temporary (2 days)\n` +
            `**Reason**: Minor violation\n` +
            `**Authorized By**: ${msg.from.username ? `@${msg.from.username}` : msg.from.first_name}\n` +
            `**Timestamp**: ${new Date().toLocaleString()}`;
        
        await this.bot.sendMessage(msg.chat.id, adminSummary, {
            parse_mode: 'Markdown',
            reply_to_message_id: msg.message_id
        });

        // Auto-remove warning after 2 days
        setTimeout(async () => {
            await Warning.updateOne(
                { userId: userId, type: 'warning', isActive: true, autoRemove: true },
                { isActive: false }
            );
            await BannedUser.updateOne({}, { $pull: { users: userId } });
            try {
                await this.bot.sendMessage(userId, `✅ Your account restrictions have been lifted. You can now resume normal activities.`);
            } catch (error) {
                console.error('Failed to notify user of auto-unban:', error);
            }
        }, 2 * 24 * 60 * 60 * 1000);
    }

    async handleUnbanUser(msg, match) {
        if (!this.adminIds.includes(msg.from.id.toString())) {
            return this.bot.sendMessage(msg.chat.id, '⛔ **Access Denied**\n\nInsufficient privileges to execute this command.', {
                parse_mode: 'Markdown',
                reply_to_message_id: msg.message_id
            });
        }
        
        const userId = match[1];
        const activeWarning = await Warning.findOne({ userId: userId, isActive: true });
        
        if (!activeWarning) {
            return this.bot.sendMessage(msg.chat.id, `⚠️ User ${userId} is not currently banned.`, {
                reply_to_message_id: msg.message_id
            });
        }
        
        await Warning.updateOne(
            { userId: userId, isActive: true },
            { isActive: false }
        );
        await BannedUser.updateOne({}, { $pull: { users: userId } });
        
        try {
            const reinstatementNotice = `**ACCOUNT RESTORED**\n\n` +
                `Your account has been restored to full functionality.\n\n` +
                `**Account Status**: Active\n` +
                `**Restoration Date**: ${new Date().toLocaleDateString()}\n\n` +
                `You can now resume all normal activities including placing orders.`;
            
            await this.bot.sendMessage(userId, reinstatementNotice, { parse_mode: 'Markdown' });
        } catch (error) {
            console.error('Reinstatement notification delivery failed:', error);
        }
        
        const adminConfirmation = `✅ **Account Unbanned**\n\n` +
            `**Account**: ${userId}\n` +
            `**Status**: Active\n` +
            `**Authorized By**: ${msg.from.username ? `@${msg.from.username}` : msg.from.first_name}\n` +
            `**Timestamp**: ${new Date().toLocaleString()}`;
        
        await this.bot.sendMessage(msg.chat.id, adminConfirmation, {
            parse_mode: 'Markdown',
            reply_to_message_id: msg.message_id
        });
    }

    async handleViewWarnings(msg, match) {
        if (!this.adminIds.includes(msg.from.id.toString())) {
            return this.bot.sendMessage(msg.chat.id, '⛔ **Access Denied**\n\nInsufficient privileges to execute this command.', {
                parse_mode: 'Markdown',
                reply_to_message_id: msg.message_id
            });
        }
        
        const userId = match[1];
        const warnings = await Warning.find({ userId: userId }).sort({ issuedAt: -1 }).limit(10);
        
        if (warnings.length === 0) {
            return this.bot.sendMessage(msg.chat.id, `📋 No warnings found for user ${userId}.`, {
                reply_to_message_id: msg.message_id
            });
        }
        
        let warningsList = `📋 **Warning History for User ${userId}**\n\n`;
        
        warnings.forEach((warning, index) => {
            const status = warning.isActive ? '🔴 Active' : '✅ Resolved';
            const expiry = warning.expiresAt ? `\n**Expires**: ${warning.expiresAt.toLocaleDateString()}` : '';
            
            warningsList += `**${index + 1}.** ${warning.type.toUpperCase()}\n` +
                `**Status**: ${status}\n` +
                `**Reason**: ${warning.reason}\n` +
                `**Date**: ${warning.issuedAt.toLocaleDateString()}${expiry}\n\n`;
        });
        
        await this.bot.sendMessage(msg.chat.id, warningsList, {
            parse_mode: 'Markdown',
            reply_to_message_id: msg.message_id
        });
    }

    // Auto-cleanup expired warnings
    startWarningCleanup() {
        setInterval(async () => {
            const expiredWarnings = await Warning.find({
                isActive: true,
                autoRemove: true,
                expiresAt: { $lte: new Date() }
            });
            
            for (const warning of expiredWarnings) {
                await Warning.updateOne(
                    { _id: warning._id },
                    { isActive: false }
                );
                await BannedUser.updateOne({}, { $pull: { users: warning.userId } });
                
                try {
                    await this.bot.sendMessage(warning.userId, `✅ Your account restrictions have been lifted. You can now resume normal activities.`);
                } catch (error) {
                    console.error('Failed to notify user of auto-unban:', error);
                }
            }
        }, 60000); // Check every minute
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