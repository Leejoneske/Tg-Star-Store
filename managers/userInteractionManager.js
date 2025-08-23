const TelegramBot = require('node-telegram-bot-api');
const { User, Referral } = require('../models');

class UserInteractionManager {
    constructor(bot) {
        this.bot = bot;
        this.setupUserHandlers();
    }

    setupUserHandlers() {
        // Start command
        this.bot.onText(/\/start(.*)/, async (msg, match) => {
            await this.handleStart(msg, match);
        });

        // Help command
        this.bot.onText(/\/help/, (msg) => {
            this.handleHelp(msg);
        });

        // Referrals command
        this.bot.onText(/\/referrals|referrals/i, async (msg) => {
            await this.handleReferrals(msg);
        });

        // General message handler
        this.bot.on('message', async (msg) => {
            await this.handleGeneralMessage(msg);
        });
    }

    async handleStart(msg, match) {
        const chatId = msg.chat.id;
        const startParam = match[1]?.trim();

        // Handle referral parameter
        if (startParam && startParam.startsWith('ref_')) {
            const referrerId = startParam.substring(4);
            await this.handleReferralStart(msg, referrerId);
            return;
        }

        // Regular start message
        const welcomeMessage = `🌟 Welcome to StarStore!\n\n` +
            `Your trusted platform for Telegram Premium and Stars.\n\n` +
            `🔗 Visit our web app: ${process.env.SERVER_URL}\n\n` +
            `Commands:\n` +
            `/help - Show help\n` +
            `/referrals - Your referral info`;

        await this.bot.sendMessage(chatId, welcomeMessage);

        // Save user if not exists
        await this.saveUser(msg);
    }

    async handleReferralStart(msg, referrerId) {
        const chatId = msg.chat.id;
        const referrerIdStr = referrerId.toString();

        // Don't allow self-referral
        if (chatId.toString() === referrerIdStr) {
            await this.bot.sendMessage(chatId, "❌ You cannot refer yourself!");
            return;
        }

        try {
            // Check if referral already exists
            const existingReferral = await Referral.findOne({
                referrerUserId: referrerIdStr,
                referredUserId: chatId.toString()
            });

            if (existingReferral) {
                await this.bot.sendMessage(chatId, "❌ You have already been referred by this user!");
                return;
            }

            // Create referral
            const referral = new Referral({
                referrerUserId: referrerIdStr,
                referredUserId: chatId.toString(),
                status: 'pending',
                dateReferred: new Date()
            });
            await referral.save();

            await this.bot.sendMessage(chatId, 
                `🎉 Welcome! You've been referred by another user.\n\n` +
                `You'll receive a bonus when you make your first purchase!`
            );

            // Notify referrer
            try {
                await this.bot.sendMessage(referrerId, 
                    `🎉 New referral! User ${msg.from.username || chatId} joined using your link.`
                );
            } catch (error) {
                console.error('Failed to notify referrer:', error);
            }

        } catch (error) {
            console.error('Error handling referral start:', error);
            await this.bot.sendMessage(chatId, "❌ Error processing referral");
        }

        // Save user
        await this.saveUser(msg);
    }

    async handleHelp(msg) {
        const chatId = msg.chat.id;
        
        const helpMessage = `📚 StarStore Help\n\n` +
            `🔗 Web App: ${process.env.SERVER_URL}\n\n` +
            `Commands:\n` +
            `/start - Start the bot\n` +
            `/help - Show this help\n` +
            `/referrals - Your referral info\n\n` +
            `Features:\n` +
            `• Buy Telegram Premium\n` +
            `• Buy Telegram Stars\n` +
            `• Sell Stars for USDT\n` +
            `• Referral program\n\n` +
            `Need help? Contact support through our web app.`;

        await this.bot.sendMessage(chatId, helpMessage);
    }

    async handleReferrals(msg) {
        const chatId = msg.chat.id;

        const referralLink = `https://t.me/TgStarStore_bot?start=ref_${chatId}`;

        const referrals = await Referral.find({ referrerUserId: chatId.toString() });

        if (referrals.length > 0) {
            const activeReferrals = referrals.filter(ref => ref.status === 'active').length;
            const pendingReferrals = referrals.filter(ref => ref.status === 'pending').length;

            let message = `📊 Your Referrals:\n\nActive: ${activeReferrals}\nPending: ${pendingReferrals}\n\n`;
            message += 'Your pending referrals will be active when they make a purchase.\n\n';
            message += `🔗 Your Referral Link:\n${referralLink}`;

            const keyboard = {
                inline_keyboard: [
                    [{ text: 'Share Referral Link', url: `https://t.me/share/url?url=${encodeURIComponent(referralLink)}` }]
                ]
            };

            await this.bot.sendMessage(chatId, message, { reply_markup: keyboard });
        } else {
            let message = `📊 Your Referrals:\n\nYou haven't referred anyone yet.\n\n`;
            message += `🔗 Your Referral Link:\n${referralLink}`;

            const keyboard = {
                inline_keyboard: [
                    [{ text: 'Share Referral Link', url: `https://t.me/share/url?url=${encodeURIComponent(referralLink)}` }]
                ]
            };

            await this.bot.sendMessage(chatId, message, { reply_markup: keyboard });
        }
    }

    async handleGeneralMessage(msg) {
        const chatId = msg.chat.id;
        const text = msg.text;

        // Ignore commands
        if (text && text.startsWith('/')) {
            return;
        }

        // Save user for any message
        await this.saveUser(msg);

        // Handle unknown messages
        if (text) {
            await this.bot.sendMessage(chatId, 
                `💬 Thanks for your message!\n\n` +
                `For the best experience, please use our web app: ${process.env.SERVER_URL}\n\n` +
                `Or use /help to see available commands.`
            );
        }
    }

    async saveUser(msg) {
        try {
            const existingUser = await User.findOne({ id: msg.from.id });
            
            if (!existingUser) {
                const newUser = new User({
                    id: msg.from.id,
                    username: msg.from.username,
                    firstName: msg.from.first_name,
                    lastName: msg.from.last_name,
                    dateCreated: new Date()
                });
                await newUser.save();
                console.log(`New user registered: ${msg.from.username || msg.from.id}`);
            } else {
                // Update existing user info
                existingUser.username = msg.from.username;
                existingUser.firstName = msg.from.first_name;
                existingUser.lastName = msg.from.last_name;
                existingUser.lastSeen = new Date();
                await existingUser.save();
            }
        } catch (error) {
            console.error('Error saving user:', error);
        }
    }
}

module.exports = UserInteractionManager;