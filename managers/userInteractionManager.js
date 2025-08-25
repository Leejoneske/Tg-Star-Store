const TelegramBot = require('node-telegram-bot-api');
const { User, BuyOrder, SellOrder, Referral } = require('../models');
const ReferralTrackingManager = require('./referralTrackingManager');

class UserInteractionManager {
    constructor(bot) {
        this.bot = bot;
        this.referralTrackingManager = new ReferralTrackingManager(bot, process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',') : []);
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

        // Handle general messages
        this.bot.on('message', async (msg) => {
            await this.handleGeneralMessage(msg);
        });
    }

    async handleStart(msg, match) {
        const chatId = msg.chat.id;
        const userId = chatId.toString();
        const referrerId = match[1];

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
                await user.save();
            } else {
                // Create new user with referral
                user = new User({
                    id: userId,
                    telegramId: userId,
                    username: username,
                    referredBy: referrerId,
                    referralDate: new Date(),
                    joinDate: new Date()
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
                    joinDate: new Date()
                });
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
        const helpMessage = `📚 **StarStore Commands**\n\n` +
            `🔹 /start - Start the bot\n` +
            `🔹 /help - Show this help message\n` +
            `🔹 /referrals - Check your referral status\n\n` +
            `💡 **How it works:**\n` +
            `• Visit our web app to buy/sell stars\n` +
            `• Complete transactions through Telegram\n` +
            `• Earn rewards through referrals\n\n` +
            `🌐 **Web App:** https://your-domain.com`;

        await this.bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
    }

    async handleReferrals(msg) {
        const chatId = msg.chat.id;
        const userId = chatId.toString();

        try {
            const user = await User.findOne({ $or: [{ id: userId }, { telegramId: userId }] });
            if (!user) {
                await this.bot.sendMessage(chatId, "❌ User not found. Please use /start first.");
                return;
            }

            // Get user's referrals
            const referrals = await Referral.find({ referrerId: userId }).sort({ dateCreated: -1 });
            
            // Get user's referral info
            const referredBy = user.referredBy ? await User.findOne({ $or: [{ id: user.referredBy }, { telegramId: user.referredBy }] }) : null;

            let message = `📊 **Your Referral Status**\n\n`;

            // Referred by someone
            if (referredBy) {
                message += `👤 **Referred by:** @${referredBy.username}\n`;
                message += `📅 **Date:** ${user.referralDate.toLocaleDateString()}\n\n`;
            }

            // User's referrals
            if (referrals.length > 0) {
                message += `🎯 **Your Referrals (${referrals.length}):**\n\n`;
                
                let activeCount = 0;
                let pendingCount = 0;
                
                for (const referral of referrals.slice(0, 5)) { // Show last 5
                    const status = referral.status === 'active' ? '✅' : '⏳';
                    message += `${status} @${referral.referredUsername} - ${referral.status}\n`;
                    
                    if (referral.status === 'active') activeCount++;
                    else pendingCount++;
                }
                
                if (referrals.length > 5) {
                    message += `... and ${referrals.length - 5} more\n`;
                }
                
                message += `\n📈 **Summary:**\n`;
                message += `✅ Active: ${activeCount}\n`;
                message += `⏳ Pending: ${pendingCount}\n`;
            } else {
                message += `🎯 **Your Referrals:** None yet\n\n`;
                message += `💡 Share your referral link to earn rewards!\n`;
                message += `Link: https://t.me/your_bot?start=${userId}`;
            }

            await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });

        } catch (error) {
            console.error('Error handling referrals command:', error);
            await this.bot.sendMessage(chatId, "❌ Error fetching referral data. Please try again.");
        }
    }

    async handleGeneralMessage(msg) {
        // Handle non-command messages if needed
        if (msg.text && !msg.text.startsWith('/')) {
            // Could add general message handling here
            return;
        }
    }

    async saveUser(msg) {
        const userId = msg.from.id.toString();
        const username = msg.from.username || `${msg.from.first_name}${msg.from.last_name ? ' ' + msg.from.last_name : ''}`;

        try {
            let user = await User.findOne({ $or: [{ id: userId }, { telegramId: userId }] });
            if (!user) {
                user = new User({
                    id: userId,
                    telegramId: userId,
                    username: username,
                    joinDate: new Date()
                });
                await user.save();
            } else {
                // Update username if changed
                if (user.username !== username) {
                    user.username = username;
                    await user.save();
                }
            }
            return user;
        } catch (error) {
            console.error('Error saving user:', error);
            return null;
        }
    }

    // Method to activate referrals when user completes a purchase
    async activateReferral(userId, orderId, stars) {
        try {
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
                    status: 'active',
                    activatedDate: new Date(),
                    activationOrderId: orderId,
                    starsPurchased: stars
                }
            );

            // Notify referrer
            try {
                const referrer = await User.findOne({ $or: [{ id: user.referredBy }, { telegramId: user.referredBy }] });
                const referredUser = await User.findOne({ $or: [{ id: userId }, { telegramId: userId }] });
                
                const notification = `🎉 Referral Activated!\n\n` +
                    `User: @${referredUser.username}\n` +
                    `Order: ${orderId}\n` +
                    `Stars: ${stars}\n\n` +
                    `Your referral bonus has been activated!`;

                await this.bot.sendMessage(parseInt(user.referredBy), notification);
            } catch (error) {
                console.error('Failed to notify referrer of activation:', error);
            }

            // Notify referred user
            try {
                const referrer = await User.findOne({ telegramId: user.referredBy });
                const notification = `🎉 Referral Bonus Activated!\n\n` +
                    `Your referral by @${referrer.username} has been activated!\n` +
                    `Both of you now qualify for referral rewards.`;

                await this.bot.sendMessage(parseInt(userId), notification);
            } catch (error) {
                console.error('Failed to notify referred user:', error);
            }

        } catch (error) {
            console.error('Error activating referral:', error);
        }
    }
}

module.exports = UserInteractionManager;