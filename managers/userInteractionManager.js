const TelegramBot = require('node-telegram-bot-api');
const { User, BuyOrder, SellOrder, Referral, Reversal } = require('../models');
const ReferralTrackingManager = require('./referralTrackingManager');
const { trackBotActivity } = require('../middleware/userActivity');
const { validateOrderId, validateRefundReason } = require('../utils/validation');
const { formatAdminNotification } = require('../utils/markdown');

class UserInteractionManager {
    constructor(bot) {
        this.bot = bot;
        this.referralTrackingManager = new ReferralTrackingManager(bot, process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',') : []);
        this.refundRequests = new Map();
        this.setupUserHandlers();
    }

    setupUserHandlers() {
        // User commands
        this.bot.onText(/^\/start(?:\s+(.+))?/, async (msg, match) => {
            await this.handleStart(msg, match);
        });

        this.bot.onText(/^\/help/, async (msg) => {
            await this.handleHelp(msg);
        });

        this.bot.onText(/^\/referrals/, async (msg) => {
            await this.handleReferrals(msg);
        });

        this.bot.onText(/^\/refund(?:\s+(.+))?/, async (msg, match) => {
            await this.handleRefundRequest(msg, match);
        });

        // Handle general messages
        this.bot.on('message', async (msg) => {
            await this.handleGeneralMessage(msg);
        });
    }

    async handleStart(msg, match) {
        const chatId = msg.chat.id;
        const userId = chatId.toString();
        const referrerId = match[1];

        // Track user activity
        await trackBotActivity(userId);

        if (referrerId) {
            await this.handleReferralStart(msg, referrerId);
        } else {
            await this.handleRegularStart(msg);
        }
    }

    async handleReferralStart(msg, referrerId) {
        const chatId = msg.chat.id;
        const userId = chatId.toString();
        const username = msg.from.username || `${msg.from.first_name}${msg.from.last_name ? ' ' + msg.from.last_name : ''}`;

        try {
            // Check if referrer exists and is not the same user
            if (referrerId === userId) {
                await this.bot.sendMessage(chatId, "❌ You cannot refer yourself!");
                return;
            }

            const referrer = await User.findOne({ $or: [{ id: referrerId }, { telegramId: referrerId }] });
            if (!referrer) {
                await this.bot.sendMessage(chatId, "❌ Invalid referral link!");
                return;
            }

            // Check if user already exists
            let user = await User.findOne({ $or: [{ id: userId }, { telegramId: userId }] });
            if (user) {
                if (user.referredBy) {
                    await this.bot.sendMessage(chatId, "❌ You have already been referred by someone else!");
                    return;
                }
                // Update existing user with referral
                user.referredBy = referrerId;
                user.referralDate = new Date();
                user.lastSeen = new Date();
                user.isActive = true;
                await user.save();
            } else {
                // Create new user with referral
                user = new User({
                    id: userId,
                    telegramId: userId,
                    username: username,
                    firstName: msg.from.first_name,
                    lastName: msg.from.last_name,
                    referredBy: referrerId,
                    referralDate: new Date(),
                    joinDate: new Date(),
                    lastSeen: new Date(),
                    isActive: true
                });
                await user.save();
            }

            // Create referral record and tracker using ReferralTrackingManager
            await this.referralTrackingManager.createReferralTracker(referrerId, userId, username);

            // Notify referrer
            try {
                const referrerMessage = `🎉 New Referral!\n\n` +
                    `User: @${username}\n` +
                    `Status: Pending activation\n\n` +
                    `They need to complete a star purchase to activate your referral bonus.`;
                await this.bot.sendMessage(parseInt(referrerId), referrerMessage);
            } catch (error) {
                console.error('Failed to notify referrer:', error);
            }

            await this.bot.sendMessage(chatId, 
                `🎉 Welcome to StarStore!\n\n` +
                `You were referred by @${referrer.username}\n\n` +
                `Complete your first star purchase to activate the referral bonus for both of you!`
            );

        } catch (error) {
            console.error('Error handling referral start:', error);
            await this.bot.sendMessage(chatId, "❌ Error processing referral. Please try again.");
        }
    }

    async handleRegularStart(msg) {
        const chatId = msg.chat.id;
        const userId = chatId.toString();
        const username = msg.from.username || `${msg.from.first_name}${msg.from.last_name ? ' ' + msg.from.last_name : ''}`;

        try {
            let user = await User.findOne({ $or: [{ id: userId }, { telegramId: userId }] });
            if (!user) {
                user = new User({
                    id: userId,
                    telegramId: userId,
                    username: username,
                    firstName: msg.from.first_name,
                    lastName: msg.from.last_name,
                    joinDate: new Date(),
                    lastSeen: new Date(),
                    isActive: true
                });
                await user.save();
            } else {
                // Update lastSeen for existing user
                user.lastSeen = new Date();
                user.isActive = true;
                await user.save();
            }

            const welcomeMessage = `🌟 Welcome to StarStore!\n\n` +
                `Buy and sell Telegram stars with ease.\n\n` +
                `Use /help to see available commands.\n` +
                `Use /referrals to check your referral status.`;

            await this.bot.sendMessage(chatId, welcomeMessage);

            // Send welcome notification
            try {
                const notificationManager = require('./notificationManager');
                const notificationInstance = new notificationManager(this.bot, []);
                await notificationInstance.sendWelcomeNotification(userId);
            } catch (notificationError) {
                console.error('Failed to send welcome notification:', notificationError);
            }

        } catch (error) {
            console.error('Error handling regular start:', error);
            await this.bot.sendMessage(chatId, "❌ Error starting bot. Please try again.");
        }
    }

    async handleHelp(msg) {
        const chatId = msg.chat.id;
        const userId = chatId.toString();
        
        // Track user activity
        await trackBotActivity(userId);
        
        const helpMessage = `📚 **StarStore Commands**\n\n` +
            `🔹 /start - Start the bot\n` +
            `🔹 /help - Show this help message\n` +
            `🔹 /referrals - Check your referral status\n` +
            `🔹 /refund [orderId] - Request a refund for your order\n\n` +
            `💡 **How it works:**\n` +
            `• Visit our web app to buy/sell stars\n` +
            `• Complete transactions through Telegram\n` +
            `• Earn rewards through referrals\n` +
            `• Request refunds for processing orders\n\n` +
            `🔄 **Refund Policy:**\n` +
            `• Only processing orders can be refunded\n` +
            `• Limited to one refund request per month\n` +
            `• Requires detailed explanation (10+ words)\n\n` +
            `🔗 **Links:**\n` +
            `• Web App: https://starstore.site\n` +
            `• Community: https://t.me/StarStore_Chat`;

        await this.bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
    }

    async handleGeneralMessage(msg) {
        const chatId = msg.chat.id;
        const userId = chatId.toString();
        
        // Track user activity for any message
        await trackBotActivity(userId);

        // Handle refund request workflow
        const request = this.refundRequests.get(chatId);
        if (request && Date.now() - request.timestamp < 300000) { // 5 minute window
            await this.handleRefundMessage(msg, request);
        }
    }

    async handleRefundMessage(msg, request) {
        const chatId = msg.chat.id;
        const userId = chatId.toString();

        if (request.step === 'waiting_order_id') {
            const orderId = msg.text.trim();
            
            // Validate order ID format
            const orderValidation = validateOrderId(orderId);
            if (!orderValidation.valid) {
                return this.bot.sendMessage(chatId, `❌ ${orderValidation.error}. Please enter a valid Order ID:`);
            }
            
            const order = await SellOrder.findOne({ id: orderValidation.orderId, telegramId: userId });
            
            if (!order) {
                return this.bot.sendMessage(chatId, "❌ Order not found or doesn't belong to you. Please enter a valid Order ID:");
            }
            if (order.status !== 'processing') {
                return this.bot.sendMessage(chatId, `❌ Order ${orderValidation.orderId} is ${order.status} - cannot be refunded. Please enter a different Order ID:`);
            }
            
            request.step = 'waiting_reason';
            request.orderId = orderValidation.orderId;
            request.timestamp = Date.now();
            this.refundRequests.set(chatId, request);
            
            return this.bot.sendMessage(chatId, 
                `📋 Order Found: ${orderValidation.orderId}\n` +
                `Stars: ${order.stars}\n\n` +
                `Please provide a detailed explanation (minimum 10 words) for why you need to refund this order:`
            );
        }

        if (request.step === 'waiting_reason') {
            const reason = msg.text.trim();
            
            // Validate refund reason
            const reasonValidation = validateRefundReason(reason);
            if (!reasonValidation.valid) {
                return this.bot.sendMessage(chatId, 
                    `❌ ${reasonValidation.error}\n` +
                    `Please explain in detail why you need this refund:`
                );
            }

            const order = await SellOrder.findOne({ id: request.orderId });
            const refundRequest = new Reversal({
                orderId: request.orderId,
                telegramId: userId,
                username: msg.from.username || `${msg.from.first_name}${msg.from.last_name ? ' ' + msg.from.last_name : ''}`,
                stars: order.stars,
                reason: reasonValidation.reason,
                status: 'pending'
            });
            await refundRequest.save();

            // Notify admins using centralized markdown formatting
            const adminIds = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',') : [];
            
            const adminMsg = formatAdminNotification({
                orderId: request.orderId,
                username: refundRequest.username,
                userId: userId,
                stars: order.stars,
                reason: reasonValidation.reason,
                type: 'refund'
            });
            
            for (const adminId of adminIds) {
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
                    
                    // Store admin message info
                    refundRequest.adminMessages.push({
                        adminId: adminId,
                        messageId: message.message_id,
                        messageType: 'refund'
                    });
                    await refundRequest.save();
                } catch (error) {
                    console.error(`Failed to notify admin ${adminId}:`, error);
                }
            }
            
            // Confirm receipt to user
            await this.bot.sendMessage(chatId, `Thank you for your refund request! We will review it and get back to you shortly.`);
            
            // Clear the request state
            this.refundRequests.delete(chatId);
        }
    }

    async handleRefundRequest(msg, match) {
        const chatId = msg.chat.id;
        const userId = chatId.toString();
        
        // Track user activity
        await trackBotActivity(userId);

        try {
            // Check monthly refund limit
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
            
            const orderId = match[1] ? match[1].trim() : null;
            
            if (!orderId) {
                const welcomeMsg = `🔄 Welcome to Refund Request System\n\n` +
                    `You are about to request a cancellation and refund for your order. ` +
                    `Please note that refund requests are limited to once per month.\n\n` +
                    `Please enter your Order ID:`;
                
                this.refundRequests.set(chatId, { 
                    step: 'waiting_order_id', 
                    timestamp: Date.now() 
                });
                return this.bot.sendMessage(chatId, welcomeMsg);
            }
            
            const order = await SellOrder.findOne({ id: orderId, telegramId: userId });
            
            if (!order) {
                return this.bot.sendMessage(chatId, "❌ Order not found or doesn't belong to you");
            }
            if (order.status !== 'processing') {
                return this.bot.sendMessage(chatId, `❌ Order is ${order.status} - cannot be refunded`);
            }
            
            this.refundRequests.set(chatId, { 
                step: 'waiting_reason',
                orderId, 
                timestamp: Date.now() 
            });
            
            await this.bot.sendMessage(chatId, 
                `📋 Order Found: ${orderId}\n` +
                `Stars: ${order.stars}\n\n` +
                `Please provide a detailed explanation (minimum 10 words) for why you need to refund this order:`
            );

        } catch (error) {
            console.error('Error handling refund request:', error);
            await this.bot.sendMessage(chatId, "❌ Error processing refund request. Please try again.");
        }
    }

    async handleReferrals(msg) {
        const chatId = msg.chat.id;
        const userId = chatId.toString();
        
        // Track user activity
        await trackBotActivity(userId);

        try {
            const user = await User.findOne({ $or: [{ id: userId }, { telegramId: userId }] });
            if (!user) {
                await this.bot.sendMessage(chatId, "❌ User not found. Please start the bot first with /start");
                return;
            }

            const referralLink = `https://t.me/TgStarStore_bot?start=ref_${userId}`;

            // Get user's referrals
            const referrals = await Referral.find({ referrerId: userId }).sort({ dateCreated: -1 });

            let message = `📊 **Your Referral Status**\n\n`;

            if (user.referredBy) {
                const referrer = await User.findOne({ $or: [{ id: user.referredBy }, { telegramId: user.referredBy }] });
                message += `👥 **Referred by:** @${referrer?.username || 'Unknown'}\n`;
                message += `📅 **Date:** ${user.referralDate.toLocaleDateString()}\n\n`;
            }

            // User's referrals
            if (referrals.length > 0) {
                message += `🎯 **Your Referrals (${referrals.length}):**\n\n`;
                let activeCount = 0;
                
                for (const referral of referrals.slice(0, 5)) { // Show last 5
                    const status = referral.status === 'active' ? '✅' : '⏳';
                    message += `${status} @${referral.referredUsername} - ${referral.status}\n`;
                    if (referral.status === 'active') activeCount++;
                }
                
                message += `\n💰 **Active Referrals:** ${activeCount}\n`;
                message += `💵 **Earnings:** ${activeCount * 0.5} USDT\n`;
                
                if (referrals.length > 5) {
                    message += `... and ${referrals.length - 5} more\n`;
                }
            } else {
                message += `🎯 **Your Referrals:** None yet\n\n`;
                message += `💡 Share your referral link to earn rewards!\n`;
            }

            message += `\n🔗 **Your Referral Link:**\n${referralLink}`;

            const keyboard = {
                inline_keyboard: [
                    [{ text: 'Share Referral Link', url: `https://t.me/share/url?url=${encodeURIComponent(referralLink)}` }]
                ]
            };

            await this.bot.sendMessage(chatId, message, { 
                parse_mode: 'Markdown',
                reply_markup: keyboard 
            });

        } catch (error) {
            console.error('Error handling referrals command:', error);
            await this.bot.sendMessage(chatId, "❌ Error fetching referral data. Please try again.");
        }
    }

    // Method to activate referrals when user completes a purchase
    async activateReferral(userId, orderId, stars) {
        try {
            // Track user activity
            await trackBotActivity(userId);

            // Check if user has a referral
            const user = await User.findOne({ $or: [{ id: userId }, { telegramId: userId }] });
            if (!user || !user.referredBy) return;

            // Check if referral is already active
            const existingReferral = await Referral.findOne({
                referrerId: user.referredBy,
                referredId: userId,
                status: 'active'
            });

            if (existingReferral) return; // Already activated

            // Update referral status
            await Referral.updateOne(
                {
                    referrerId: user.referredBy,
                    referredId: userId
                },
                {
                    $set: {
                        status: 'active',
                        activatedDate: new Date(),
                        activationOrderId: orderId,
                        starsPurchased: stars
                    }
                }
            );

            // Get referrer details
            const referrer = await User.findOne({ $or: [{ id: user.referredBy }, { telegramId: user.referredBy }] });

            // Notify referrer
            const notification = `🎉 Referral Activated!\n\n` +
                `Your referral @${user.username} just completed their first purchase!\n` +
                `You both now qualify for referral rewards.`;

            await this.bot.sendMessage(user.referredBy, notification);

            // Notify referred user
            const userNotification = `🎉 Referral Bonus Activated!\n\n` +
                `Your referral by @${referrer.username} has been activated!\n` +
                `Both of you now qualify for referral rewards.`;

            await this.bot.sendMessage(userId, userNotification);

        } catch (error) {
            console.error('Error activating referral:', error);
        }
    }
}

module.exports = UserInteractionManager;