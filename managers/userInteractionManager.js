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

        // Withdrawal commands
        this.bot.onText(/\/withdraw (.+)/, async (msg, match) => {
            await this.handleWithdrawCommand(msg, match);
        });

        this.bot.onText(/\/withdrawals/, async (msg) => {
            await this.handleWithdrawalsCommand(msg);
        });

        this.bot.onText(/\/balance/, async (msg) => {
            await this.handleBalanceCommand(msg);
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
        
        const helpMessage = `🤖 **Welcome to Telegram Star Store Bot!**\n\n` +
                           `**Available Commands:**\n\n` +
                           `📋 **General Commands:**\n` +
                           `• /start - Start the bot\n` +
                           `• /help - Show this help message\n` +
                           `• /buy - Buy Telegram Stars\n` +
                           `• /sell - Sell Telegram Stars\n` +
                           `• /orders - View your orders\n` +
                           `• /refund - Request a refund\n\n` +
                           `💰 **Referral System:**\n` +
                           `• /referrals - View your referrals\n` +
                           `• /balance - Check your referral balance\n` +
                           `• /withdraw <amount> <wallet> - Withdraw earnings\n` +
                           `• /withdrawals - View withdrawal history\n\n` +
                           `📞 **Support:**\n` +
                           `• Contact support for any issues\n\n` +
                           `**Referral Link:**\n` +
                           `Share this link to earn: https://t.me/TgStarStore_bot?start=ref_${msg.from.id}`;

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

    async handleWithdrawCommand(msg, match) {
        const userId = msg.from.id.toString();
        const args = match[1].trim().split(' ');
        
        if (args.length < 2) {
            return this.bot.sendMessage(msg.chat.id, 
                '❌ **Invalid Format**\n\n' +
                'Usage: `/withdraw <amount> <wallet_address>`\n\n' +
                'Example: `/withdraw 5.0 TRC20_WALLET_ADDRESS`\n\n' +
                'Minimum withdrawal: 0.5 USDT', {
                parse_mode: 'Markdown',
                reply_to_message_id: msg.message_id
            });
        }

        const [amount, ...walletParts] = args;
        const walletAddress = walletParts.join(' ');

        try {
            const amountNum = parseFloat(amount);
            if (isNaN(amountNum) || amountNum < 0.5) {
                return this.bot.sendMessage(msg.chat.id, 
                    '❌ **Invalid Amount**\n\nMinimum withdrawal is 0.5 USDT', {
                    parse_mode: 'Markdown',
                    reply_to_message_id: msg.message_id
                });
            }

            if (!walletAddress || walletAddress.length < 10) {
                return this.bot.sendMessage(msg.chat.id, 
                    '❌ **Invalid Wallet Address**\n\nPlease provide a valid wallet address', {
                    parse_mode: 'Markdown',
                    reply_to_message_id: msg.message_id
                });
            }

            // Create withdrawal using WithdrawalManager
            const { WithdrawalManager } = require('./withdrawalManager');
            const withdrawalManager = new WithdrawalManager(this.bot, this.adminIds);
            
            const withdrawal = await withdrawalManager.createWithdrawal(userId, amountNum, walletAddress);

            await this.bot.sendMessage(msg.chat.id, 
                '✅ **Withdrawal Request Submitted**\n\n' +
                `Amount: ${amountNum} USDT\n` +
                `Wallet: ${walletAddress.substring(0, 6)}...${walletAddress.slice(-4)}\n` +
                `ID: WD${withdrawal._id.toString().slice(-8).toUpperCase()}\n\n` +
                'Status: Pending approval', {
                parse_mode: 'Markdown',
                reply_to_message_id: msg.message_id
            });

        } catch (error) {
            console.error('Withdrawal error:', error);
            await this.bot.sendMessage(msg.chat.id, 
                `❌ **Withdrawal Failed**\n\n${error.message}`, {
                parse_mode: 'Markdown',
                reply_to_message_id: msg.message_id
            });
        }
    }

    async handleWithdrawalsCommand(msg) {
        const userId = msg.from.id.toString();

        try {
            const { WithdrawalManager } = require('./withdrawalManager');
            const withdrawalManager = new WithdrawalManager(this.bot, this.adminIds);
            
            const withdrawals = await withdrawalManager.getWithdrawalHistory(userId);

            if (withdrawals.length === 0) {
                return this.bot.sendMessage(msg.chat.id, 
                    '📋 **No Withdrawals Found**\n\nYou haven\'t made any withdrawal requests yet.', {
                    parse_mode: 'Markdown',
                    reply_to_message_id: msg.message_id
                });
            }

            let message = '📋 **Your Withdrawal History**\n\n';
            
            for (const withdrawal of withdrawals.slice(0, 5)) {
                const status = withdrawal.status === 'completed' ? '✅' : 
                              withdrawal.status === 'pending' ? '⏳' : '❌';
                const withdrawalId = `WD${withdrawal._id.toString().slice(-8).toUpperCase()}`;
                
                message += `${status} **${withdrawalId}**\n`;
                message += `💰 ${withdrawal.amount} USDT\n`;
                message += `📅 ${withdrawal.createdAt.toLocaleDateString()}\n`;
                message += `Status: ${withdrawal.status.charAt(0).toUpperCase() + withdrawal.status.slice(1)}\n\n`;
            }

            if (withdrawals.length > 5) {
                message += `... and ${withdrawals.length - 5} more withdrawals`;
            }

            await this.bot.sendMessage(msg.chat.id, message, {
                parse_mode: 'Markdown',
                reply_to_message_id: msg.message_id
            });

        } catch (error) {
            console.error('Withdrawals history error:', error);
            await this.bot.sendMessage(msg.chat.id, 
                '❌ **Error**\n\nFailed to load withdrawal history', {
                parse_mode: 'Markdown',
                reply_to_message_id: msg.message_id
            });
        }
    }

    async handleBalanceCommand(msg) {
        const userId = msg.from.id.toString();

        try {
            const { Referral } = require('../models');
            
            const availableReferrals = await Referral.find({
                referrerId: userId,
                status: { $in: ['completed', 'active'] },
                withdrawn: { $ne: true }
            }).lean();

            const availableBalance = availableReferrals.length * 0.5;
            const totalReferrals = await Referral.countDocuments({ referrerId: userId });

            const message = '💰 **Your Referral Balance**\n\n' +
                           `Available: **${availableBalance.toFixed(2)} USDT**\n` +
                           `Active Referrals: **${availableReferrals.length}**\n` +
                           `Total Referrals: **${totalReferrals}**\n\n` +
                           'Use `/withdraw <amount> <wallet>` to withdraw your earnings';

            await this.bot.sendMessage(msg.chat.id, message, {
                parse_mode: 'Markdown',
                reply_to_message_id: msg.message_id
            });

        } catch (error) {
            console.error('Balance error:', error);
            await this.bot.sendMessage(msg.chat.id, 
                '❌ **Error**\n\nFailed to load balance information', {
                parse_mode: 'Markdown',
                reply_to_message_id: msg.message_id
            });
        }
    }
}

module.exports = UserInteractionManager;