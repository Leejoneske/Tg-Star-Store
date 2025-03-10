require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const axios = require('axios');

const app = express();
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

app.use(express.static('public'));
app.use(express.json());

mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('✅ MongoDB connected successfully'))
    .catch(err => console.error('❌ MongoDB connection error:', err));

const buyOrderSchema = new mongoose.Schema({
    id: String,
    telegramId: String,
    username: String,
    amount: Number,
    stars: Number,
    premiumDuration: Number,
    walletAddress: String,
    isPremium: Boolean,
    status: String,
    dateCreated: Date,
    adminMessages: Array
});

const sellOrderSchema = new mongoose.Schema({
    id: String,
    telegramId: String,
    username: String,
    stars: Number,
    walletAddress: String,
    status: String,
    reversible: Boolean,
    dateCreated: Date,
    adminMessages: Array
});

const userSchema = new mongoose.Schema({
    id: String,
    username: String
});

const notificationSchema = new mongoose.Schema({
    message: String,
    timestamp: String
});

const referralSchema = new mongoose.Schema({
    referredUserId: String,
    referrerUserId: String,
    status: String,
    dateReferred: Date,
    dateCompleted: Date
});

const cancelledOrderSchema = new mongoose.Schema({
    orders: Array
});

const bannedUserSchema = new mongoose.Schema({
    users: Array
});

const giveawaySchema = new mongoose.Schema({
    code: String,
    limit: Number,
    claimed: Number,
    users: Array,
    status: String,
    createdAt: Date,
    expiresAt: Date
});

const giftSchema = new mongoose.Schema({
    id: String,
    telegramId: String,
    username: String,
    stars: Number,
    walletAddress: String,
    status: String,
    dateCreated: Date,
    adminMessages: Array,
    giveawayCode: String
});

const reverseOrderSchema = new mongoose.Schema({
    id: String,
    originalOrderId: String,
    telegramId: String,
    username: String,
    stars: Number,
    status: String,
    dateRequested: Date
});

const BuyOrder = mongoose.model('BuyOrder', buyOrderSchema);
const SellOrder = mongoose.model('SellOrder', sellOrderSchema);
const User = mongoose.model('User', userSchema);
const Notification = mongoose.model('Notification', notificationSchema);
const Referral = mongoose.model('Referral', referralSchema);
const CancelledOrder = mongoose.model('CancelledOrder', cancelledOrderSchema);
const BannedUser = mongoose.model('BannedUser', bannedUserSchema);
const Giveaway = mongoose.model('Giveaway', giveawaySchema);
const Gift = mongoose.model('Gift', giftSchema);
const ReverseOrder = mongoose.model('ReverseOrder', reverseOrderSchema);

const adminIds = process.env.ADMIN_TELEGRAM_IDS.split(',').map(id => id.trim());

function generateOrderId() {
    return Array.from({ length: 6 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 36)]).join('');
}

async function updateOrderMessages(order, newStatus, reason = '') {
    const statusMessage = newStatus === 'completed' ? '✅ Order Completed' :
                          newStatus === 'declined' ? '❌ Order Declined' :
                          newStatus === 'canceled' ? '❌ Order Canceled' : '🔄 Order Updated';

    const userMessage = `Your order has been updated:\n\nOrder ID: ${order.id}\nStatus: ${statusMessage}\n${reason ? `Reason: ${reason}` : ''}`;
    await bot.sendMessage(order.telegramId, userMessage);

    for (const adminMessage of order.adminMessages) {
        const adminStatusMessage = `Order ID: ${order.id}\nUser: @${order.username}\nStatus: ${statusMessage}\n${reason ? `Reason: ${reason}` : ''}`;
        try {
            await bot.editMessageText(adminStatusMessage, {
                chat_id: adminMessage.adminId,
                message_id: adminMessage.messageId
            });
            await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
                chat_id: adminMessage.adminId,
                message_id: adminMessage.messageId
            });
        } catch (err) {
            console.error(`Failed to update message for admin ${adminMessage.adminId}:`, err);
        }
    }
}

app.get('/api/get-wallet-address', (req, res) => {
    const walletAddress = process.env.WALLET_ADDRESS;
    walletAddress ? res.json({ walletAddress }) : res.status(500).json({ error: 'Wallet address not configured' });
});

app.post('/api/orders/create', async (req, res) => {
    try {
        const { telegramId, username, stars, walletAddress, isPremium, premiumDuration } = req.body;

        if (!telegramId || !username || !walletAddress || (isPremium && !premiumDuration)) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const bannedUser = await BannedUser.findOne({ users: telegramId.toString() });
        if (bannedUser) {
            return res.status(403).json({ error: 'You are banned from placing orders' });
        }

        const priceMap = {
            regular: {
                1000: 20,
                500: 10,
                100: 2,
                50: 1,
                25: 0.6,
                15: 0.35
            },
            premium: {
                3: 19.31,
                6: 26.25,
                12: 44.79
            }
        };

        let amount, packageType;
        if (isPremium) {
            packageType = 'premium';
            amount = priceMap.premium[premiumDuration];
        } else {
            packageType = 'regular';
            amount = priceMap.regular[stars];
        }

        if (!amount) {
            return res.status(400).json({ error: 'Invalid selection' });
        }

        const order = new BuyOrder({
            id: generateOrderId(),
            telegramId,
            username,
            amount,
            stars: isPremium ? null : stars,
            premiumDuration: isPremium ? premiumDuration : null,
            walletAddress,
            isPremium,
            status: 'pending',
            dateCreated: new Date(),
            adminMessages: []
        });

        await order.save();

        const userMessage = isPremium ?
            `🎉 Premium order received!\n\nOrder ID: ${order.id}\nAmount: ${amount} USDT\nDuration: ${premiumDuration} months\nStatus: Pending` :
            `🎉 Order received!\n\nOrder ID: ${order.id}\nAmount: ${amount} USDT\nStars: ${stars}\nStatus: Pending`;

        await bot.sendMessage(telegramId, userMessage);

        const adminMessage = isPremium ?
            `🛒 New Premium Order!\n\nOrder ID: ${order.id}\nUser: @${username}\nAmount: ${amount} USDT\nDuration: ${premiumDuration} months` :
            `🛒 New Order!\n\nOrder ID: ${order.id}\nUser: @${username}\nAmount: ${amount} USDT\nStars: ${stars}`;

        const adminKeyboard = {
            inline_keyboard: [[
                { text: 'Mark as Complete', callback_data: `complete_${order.id}` },
                { text: 'Decline Order', callback_data: `decline_${order.id}` }
            ]]
        };

        for (const adminId of adminIds) {
            try {
                const message = await bot.sendMessage(adminId, adminMessage, { reply_markup: adminKeyboard });
                order.adminMessages.push({ adminId, messageId: message.message_id });
            } catch (err) {
                console.error(`Failed to send message to admin ${adminId}:`, err);
            }
        }

        const referral = await Referral.findOne({ referredUserId: telegramId });

        if (referral && referral.status === 'pending') {
            referral.status = 'active';
            referral.dateCompleted = new Date();
            await referral.save();

            await bot.sendMessage(
                referral.referrerUserId,
                `🎉 Your referral @${username} has made a purchase! Thank you for bringing them to StarStore.`
            );
        }

        res.json({ success: true, order });
    } catch (err) {
        console.error('Order creation error:', err);
        res.status(500).json({ error: 'Failed to create order' });
    }
});
app.post("/api/sell-orders", async (req, res) => {
    try {
        const { telegramId, username, stars, walletAddress } = req.body;

        if (!telegramId || !stars || !walletAddress) {
            return res.status(400).json({ error: "Missing required fields" });
        }

        const bannedUser = await BannedUser.findOne({ users: telegramId.toString() });
        if (bannedUser) {
            return res.status(403).json({ error: "You are banned from placing orders" });
        }

        const order = new SellOrder({
            id: generateOrderId(),
            telegramId,
            username,
            stars,
            walletAddress,
            status: "pending",
            reversible: true,
            dateCreated: new Date(),
            adminMessages: [],
        });

        await order.save();

        const paymentLink = await createTelegramInvoice(telegramId, order.id, stars, `Purchase of ${stars} Telegram Stars`);

        if (!paymentLink) {
            return res.status(500).json({ error: "Failed to generate payment link" });
        }

        const userMessage = `🛒 Sell order created!\n\nOrder ID: ${order.id}\nStars: ${order.stars}\nStatus: Pending (Waiting for payment)\n\nPay here: ${paymentLink}`;
        await bot.sendMessage(telegramId, userMessage);

        res.json({ success: true, order, paymentLink });
    } catch (err) {
        console.error("Sell order creation error:", err);
        res.status(500).json({ error: "Failed to create sell order" });
    }
});

async function createTelegramInvoice(chatId, orderId, stars, description) {
    try {
        const response = await axios.post(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/createInvoiceLink`, {
            chat_id: chatId,
            provider_token: process.env.PROVIDER_TOKEN,
            title: `Purchase of ${stars} Telegram Stars`,
            description: description,
            payload: orderId,
            currency: 'XTR',
            prices: [
                {
                    label: `${stars} Telegram Stars`,
                    amount: stars * 1
                }
            ]
        });

        if (response.data.ok) {
            return response.data.result;
        } else {
            throw new Error(response.data.description || 'Failed to create invoice');
        }
    } catch (error) {
        console.error('Error creating Telegram invoice:', error);
        throw error;
    }
}

bot.on('pre_checkout_query', async (query) => {
    const orderId = query.invoice_payload;

    let order = await SellOrder.findOne({ id: orderId });

    if (!order) {
        order = await BuyOrder.findOne({ id: orderId });
    }

    if (order) {
        bot.answerPreCheckoutQuery(query.id, true);
    } else {
        bot.answerPreCheckoutQuery(query.id, false, { error_message: 'Order not found' });
    }
});

bot.on("successful_payment", async (msg) => {
    const orderId = msg.successful_payment.invoice_payload;

    const order = await SellOrder.findOne({ id: orderId });

    if (order) {
        order.status = "pending";
        order.datePaid = new Date();
        await order.save();

        const userMessage = `✅ Payment successful!\n\nOrder ID: ${order.id}\nStars: ${order.stars}\nStatus: Pending (Waiting for admin verification)`;
        await bot.sendMessage(order.telegramId, userMessage);

        const adminMessage = `🛒 Payment Received!\n\nOrder ID: ${order.id}\nUser: @${order.username}\nStars: ${order.stars}\nWallet Address: ${order.walletAddress}`;
        const adminKeyboard = {
            inline_keyboard: [
                [
                    { text: "✅ Mark as Complete", callback_data: `complete_${order.id}` },
                    { text: "❌ Decline Order", callback_data: `decline_${order.id}` },
                ],
            ],
        };

        for (const adminId of adminIds) {
            try {
                const message = await bot.sendMessage(adminId, adminMessage, { reply_markup: adminKeyboard });
                order.adminMessages.push({ adminId, messageId: message.message_id });
            } catch (err) {
                console.error(`Failed to notify admin ${adminId}:`, err);
            }
        }
    } else {
        await bot.sendMessage(msg.chat.id, "❌ Payment was successful, but the order was not found. Please contact support.");
    }
});


    if (data.startsWith('complete_') || data.startsWith('decline_')) {
    
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    if (data.startsWith('complete_') || data.startsWith('decline_')) {
        const orderId = data.split('_')[1];

        const buyOrder = await BuyOrder.findOne({ id: orderId });
        const sellOrder = await SellOrder.findOne({ id: orderId });

        const order = buyOrder || sellOrder;

        if (!order) {
            return bot.answerCallbackQuery(query.id, { text: 'Order not found.' });
        }

        if (data.startsWith('complete_')) {
            order.status = 'completed';
            order.completedAt = new Date();
            await order.save();

            const userMessage = `✅ Your order (ID: ${order.id}) has been confirmed!\n\nThank you for using StarStore!`;
            await bot.sendMessage(order.telegramId, userMessage);

            const adminMessage = `✅ Order Confirmed!\n\nOrder ID: ${order.id}\nUser: @${order.username}\nAmount: ${order.amount} USDT\nStatus: Completed`;
            await bot.sendMessage(chatId, adminMessage);

            bot.answerCallbackQuery(query.id, { text: 'Order confirmed' });
        } else if (data.startsWith('decline_')) {
            order.status = 'declined';
            order.declinedAt = new Date();
            await order.save();

            const userMessage = `❌ Your order (ID: ${order.id}) has been declined.\n\nPlease contact support if you believe this is a mistake.`;
            await bot.sendMessage(order.telegramId, userMessage);

            const adminMessage = `❌ Order Declined!\n\nOrder ID: ${order.id}\nUser: @${order.username}\nAmount: ${order.amount} USDT\nStatus: Declined`;
            await bot.sendMessage(chatId, adminMessage);

            bot.answerCallbackQuery(query.id, { text: 'Order declined' });
        }

        for (const adminMessage of order.adminMessages) {
            try {
                await bot.editMessageReplyMarkup(
                    { inline_keyboard: [] },
                    {
                        chat_id: adminMessage.adminId,
                        message_id: adminMessage.messageId,
                    }
                );
            } catch (err) {
                console.error(`Failed to remove buttons for admin ${adminMessage.adminId}:`, err);
            }
        }
    }
});

bot.onText(/\/ban (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!adminIds.includes(chatId.toString())) return bot.sendMessage(chatId, '❌ Unauthorized');

    const userId = match[1];
    const bannedUser = await BannedUser.findOne({ users: userId });

    if (bannedUser) {
        bot.sendMessage(chatId, `❌ User ${userId} is already banned.`);
    } else {
        await BannedUser.updateOne({}, { $push: { users: userId } }, { upsert: true });

        const banMessage = `🚫 **Account Suspension Notice**\n\nWe regret to inform you that your account has been suspended due to a violation of our terms of service.\n\nIf you believe this is a mistake, please contact our support team for further assistance.\n\nThank you for your understanding.`;
        bot.sendMessage(userId, banMessage, { parse_mode: 'Markdown' });

        bot.sendMessage(chatId, `✅ User ${userId} has been banned.`);
    }
});

bot.onText(/\/unban (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!adminIds.includes(chatId.toString())) return bot.sendMessage(chatId, '❌ Unauthorized');

    const userId = match[1];
    const bannedUser = await BannedUser.findOne({ users: userId });

    if (!bannedUser) {
        bot.sendMessage(chatId, `❌ User ${userId} is not banned.`);
    } else {
        await BannedUser.updateOne({}, { $pull: { users: userId } });

        const unbanMessage = `🎉 **Account Reinstated**\n\nWe are pleased to inform you that your account has been reinstated. Welcome back!\n\nThank you for your patience and understanding.`;
        bot.sendMessage(userId, unbanMessage, { parse_mode: 'Markdown' });

        bot.sendMessage(chatId, `✅ User ${userId} has been unbanned.`);
    }
});

bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const username = msg.from.username;

    const user = await User.findOne({ id: chatId });

    if (!user) {
        await User.create({ id: chatId, username });
    }

    bot.sendMessage(chatId, `👋 Hello @${username}, welcome to StarStore!\n\nUse the app to purchase stars and enjoy exclusive benefits. 🌟`);
});

bot.onText(/\/help/, (msg) => {
    const chatId = msg.chat.id;
    const username = msg.from.username;

    bot.sendMessage(chatId, `🆘 Need help? Please describe your issue and we will get back to you shortly.`);
    bot.sendMessage(chatId, "Please type your message below:");

    bot.once('message', (userMsg) => {
        const userMessageText = userMsg.text;
        adminIds.forEach(adminId => {
            bot.sendMessage(adminId, `🆘 Help Request from @${username} (ID: ${chatId}):\n\n${userMessageText}`);
        });
        bot.sendMessage(chatId, "Your message has been sent to the admins. We will get back to you shortly.");
    });
});

bot.on('web_app_data', (msg) => {
    const data = JSON.parse(msg.web_app_data.data);
    const userId = data.userId;
    const username = data.username;
    const message = data.message;

    const adminMessage = `🆘 Help Request from @${username} (ID: ${userId}):\n\n${message}`;
    adminIds.forEach(adminId => {
        bot.sendMessage(adminId, adminMessage);
    });

    bot.sendMessage(userId, "Your message has been sent to the admins. We will get back to you shortly.");
});

bot.onText(/\/reply (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    if (!adminIds.includes(chatId.toString())) return bot.sendMessage(chatId, '❌ Unauthorized');

    const replyText = match[1];
    const [userId, ...messageParts] = replyText.split(' ');
    const message = messageParts.join(' ');

    bot.sendMessage(userId, `📨 Admin Response:\n\n${message}`)
        .then(() => bot.sendMessage(chatId, `✅ Message sent to ${userId}`))
        .catch(err => {
            console.error(`Failed to message ${userId}:`, err);
            bot.sendMessage(chatId, `❌ Failed to message ${userId}`);
        });
});

bot.onText(/\/broadcast/, (msg) => {
    const chatId = msg.chat.id;
    if (!adminIds.includes(chatId.toString())) return bot.sendMessage(chatId, '❌ Unauthorized');

    bot.sendMessage(chatId, 'Enter broadcast message:');
    bot.once('message', async (msg) => {
        const message = msg.text || msg.caption;
        const media = msg.photo || msg.document || msg.video || msg.audio;

        let successCount = 0, failCount = 0;
        const users = await User.find({});
        for (const user of users) {
            try {
                media ? await bot.sendMediaGroup(user.id, media, { caption: message }) : await bot.sendMessage(user.id, message);
                successCount++;
            } catch (err) {
                console.error(`Failed to send to ${user.id}:`, err);
                failCount++;
            }
        }
        bot.sendMessage(chatId, `📢 Broadcast results:\n✅ ${successCount} | ❌ ${failCount}`);
    });
});

app.get('/api/notifications', async (req, res) => {
    const notifications = await Notification.find({});
    res.json({ notifications });
});

bot.onText(/\/notify (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!adminIds.includes(chatId.toString())) {
        bot.sendMessage(chatId, '❌ Unauthorized: Only admins can use this command.');
        return;
    }

    const notificationMessage = match[1];
    const timestamp = new Date().toLocaleTimeString();

    await Notification.create({ message: notificationMessage, timestamp });

    bot.sendMessage(chatId, `✅ Notification sent at ${timestamp}:\n\n${notificationMessage}`)
        .catch(err => {
            console.error('Failed to send confirmation to admin:', err);
            bot.sendMessage(chatId, '❌ Failed to send notification.');
        });
});

app.get('/api/transactions/:userId', async (req, res) => {
    const userId = req.params.userId;
    const buyOrders = await BuyOrder.find({ telegramId: userId });
    const sellOrders = await SellOrder.find({ telegramId: userId });

    const userTransactions = [...buyOrders, ...sellOrders].sort((a, b) => new Date(b.dateCreated) - new Date(a.dateCreated));
    res.json(userTransactions);
});

app.get('/api/referrals/:userId', async (req, res) => {
    const userId = req.params.userId;
    const referrals = await Referral.find({ referrerUserId: userId });

    const sortedReferrals = referrals.sort((a, b) => new Date(b.dateReferred) - new Date(a.dateReferred));
    const latestReferrals = sortedReferrals.slice(0, 3);

    const activeReferrals = referrals.filter(ref => ref.status === 'active').length;
    const pendingReferrals = referrals.filter(ref => ref.status === 'pending').length;

    const response = {
        count: activeReferrals,
        earnedStars: activeReferrals * 10,
        recentReferrals: latestReferrals.map(ref => ({
            name: ref.referredUserId,
            status: ref.status,
            daysAgo: Math.floor((new Date() - new Date(ref.dateReferred)) / (1000 * 60 * 60 * 24))
        }))
    };

    res.json(response);
});

bot.onText(/\/referrals/, async (msg) => {
    const chatId = msg.chat.id;

    const referrals = await Referral.find({ referrerUserId: chatId.toString() });

    if (referrals.length > 0) {
        const activeReferrals = referrals.filter(ref => ref.status === 'active').length;
        const pendingReferrals = referrals.filter(ref => ref.status === 'pending').length;

        let message = `📊 Your Referrals:\n\nActive: ${activeReferrals}\nPending: ${pendingReferrals}\n\n`;
        message += 'Your pending referrals will be active when they make a purchase.';

        await bot.sendMessage(chatId, message);
    } else {
        await bot.sendMessage(chatId, 'You have no referrals yet.');
    }
});        

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (!text) return;

    const orderId = text.startsWith('/order ') ? text.split(' ')[1] : text;

    const buyOrder = await BuyOrder.findOne({ id: orderId, telegramId: chatId });
    const sellOrder = await SellOrder.findOne({ id: orderId, telegramId: chatId });

    if (buyOrder) {
        const message = `🛒 Buy Order Details:\n\nOrder ID: ${buyOrder.id}\nAmount: ${buyOrder.amount} USDT\nStatus: ${buyOrder.status}`;
        await bot.sendMessage(chatId, message);
    } else if (sellOrder) {
        const message = `🛒 Sell Order Details:\n\nOrder ID: ${sellOrder.id}\nStars: ${sellOrder.stars}\nStatus: ${sellOrder.status}`;
        await bot.sendMessage(chatId, message);
    }
});

app.post('/api/orders/create', async (req, res) => {
    try {
        const { telegramId, username, stars, walletAddress, isPremium, premiumDuration } = req.body;

        const priceMap = {
            regular: {
                1000: 20,
                500: 10,
                100: 2,
                50: 1,
                25: 0.6,
                15: 0.35
            },
            premium: {
                3: 19.31,
                6: 26.25,
                12: 44.79
            }
        };

        let amount;
        if (isPremium) {
            amount = priceMap.premium[premiumDuration];
        } else {
            amount = priceMap.regular[stars];
        }

        if (!amount) {
            return res.status(400).json({ error: 'Invalid selection' });
        }

        const order = new BuyOrder({
            id: generateOrderId(),
            telegramId,
            username,
            amount,
            stars: isPremium ? null : stars,
            premiumDuration: isPremium ? premiumDuration : null,
            walletAddress,
            isPremium,
            status: 'pending',
            dateCreated: new Date(),
            adminMessages: []
        });

        await order.save();

        const giveaway = await Giveaway.findOne({ users: telegramId, status: 'active' });

        if (giveaway) {
            const giftOrder = new Gift({
                id: generateOrderId(),
                telegramId,
                username,
                stars: 15,
                walletAddress,
                status: 'pending',
                dateCreated: new Date(),
                adminMessages: [],
                giveawayCode: giveaway.code
            });

            await giftOrder.save();

            const userMessage = `🎉 You have received 15 bonus stars from the giveaway!\n\nYour giveaway order (ID: ${giftOrder.id}) is pending admin approval.`;
            await bot.sendMessage(telegramId, userMessage);

            const adminMessage = `🎉 New Giveaway Order!\n\nOrder ID: ${giftOrder.id}\nUser: @${username} (ID: ${telegramId})\nStars: 15 (Giveaway)\nCode: ${giveaway.code}`;

            const adminKeyboard = {
                inline_keyboard: [
                    [
                        { text: 'Confirm', callback_data: `confirm_gift_${giftOrder.id}` },
                        { text: 'Decline', callback_data: `decline_gift_${giftOrder.id}` }
                    ]
                ]
            };

            for (const adminId of adminIds) {
                try {
                    const message = await bot.sendMessage(adminId, adminMessage, { reply_markup: adminKeyboard });
                    giftOrder.adminMessages.push({ adminId, messageId: message.message_id });
                } catch (err) {
                    console.error(`Failed to send message to admin ${adminId}:`, err);
                }
            }

            giveaway.status = 'completed';
            await giveaway.save();
        }

        res.json({ success: true, order });
    } catch (err) {
        console.error('Order creation error:', err);
        res.status(500).json({ error: 'Failed to create order' });
    }
});

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    if (data.startsWith('complete_')) {
        const orderId = data.split('_')[1];
        const order = await BuyOrder.findOne({ id: orderId });

        if (order) {
            order.status = 'completed';
            order.completedAt = new Date();
            await order.save();

            const userMessage = `✅ Your order (ID: ${order.id}) has been confirmed!\n\nThank you for using StarStore!`;
            await bot.sendMessage(order.telegramId, userMessage);

            const giveaway = await Giveaway.findOne({ users: order.telegramId, status: 'active' });

            if (giveaway) {
                const giftOrder = new Gift({
                    id: generateOrderId(),
                    telegramId: order.telegramId,
                    username: order.username,
                    stars: 15,
                    walletAddress: order.walletAddress,
                    status: 'pending',
                    dateCreated: new Date(),
                    adminMessages: [],
                    giveawayCode: giveaway.code
                });

                await giftOrder.save();

                const userGiftMessage = `🎉 You have received 15 bonus stars from the giveaway!\n\nYour giveaway order (ID: ${giftOrder.id}) is pending admin approval.`;
                await bot.sendMessage(order.telegramId, userGiftMessage);

                const adminGiftMessage = `🎉 New Giveaway Order!\n\nOrder ID: ${giftOrder.id}\nUser: @${order.username} (ID: ${order.telegramId})\nStars: 15 (Giveaway)\nCode: ${giveaway.code}`;

                const adminGiftKeyboard = {
                    inline_keyboard: [
                        [
                            { text: 'Confirm', callback_data: `confirm_gift_${giftOrder.id}` },
                            { text: 'Decline', callback_data: `decline_gift_${giftOrder.id}` }
                        ]
                    ]
                };

                for (const adminId of adminIds) {
                    try {
                        const message = await bot.sendMessage(adminId, adminGiftMessage, { reply_markup: adminGiftKeyboard });
                        giftOrder.adminMessages.push({ adminId, messageId: message.message_id });
                    } catch (err) {
                        console.error(`Failed to send message to admin ${adminId}:`, err);
                    }
                }

                giveaway.status = 'completed';
                await giveaway.save();
            }

            const adminMessage = `✅ Order Confirmed!\n\nOrder ID: ${order.id}\nUser: @${order.username} (ID: ${order.telegramId})\nAmount: ${order.amount} USDT\nStatus: Completed`;

            for (const adminId of adminIds) {
                try {
                    await bot.sendMessage(adminId, adminMessage);
                } catch (err) {
                    console.error(`Failed to send message to admin ${adminId}:`, err);
                }
            }

            bot.answerCallbackQuery(query.id, { text: 'Order confirmed' });
        }
    } else if (data.startsWith('decline_')) {
        const orderId = data.split('_')[1];
        const order = await BuyOrder.findOne({ id: orderId });

        if (order) {
            order.status = 'declined';
            order.declinedAt = new Date();
            await order.save();

            const userMessage = `❌ Your order (ID: ${order.id}) has been declined.\n\nPlease contact support if you believe this is a mistake.`;
            await bot.sendMessage(order.telegramId, userMessage);

            const giveaway = await Giveaway.findOne({ users: order.telegramId, status: 'active' });

            if (giveaway) {
                giveaway.status = 'rejected';
                await giveaway.save();

                const userGiftMessage = `❌ Your giveaway code (${giveaway.code}) has been rejected because your order was declined.`;
                await bot.sendMessage(order.telegramId, userGiftMessage);
            }

            const adminMessage = `❌ Order Declined!\n\nOrder ID: ${order.id}\nUser: @${order.username} (ID: ${order.telegramId})\nAmount: ${order.amount} USDT\nStatus: Declined`;

            for (const adminId of adminIds) {
                try {
                    await bot.sendMessage(adminId, adminMessage);
                } catch (err) {
                    console.error(`Failed to send message to admin ${adminId}:`, err);
                }
            }

            bot.answerCallbackQuery(query.id, { text: 'Order declined' });
        }
    }
});

function createGiveaway(code, limit) {
    const giveaway = new Giveaway({
        code,
        limit,
        claimed: 0,
        users: [],
        status: 'active',
        createdAt: new Date(),
        expiresAt: new Date(new Date().getTime() + 30 * 24 * 60 * 60 * 1000)
    });

    giveaway.save();
}

function generateGiveawayCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

bot.onText(/\/create_giveaway(?: (.+) (.+))?/, (msg, match) => {
    const chatId = msg.chat.id;
    if (!adminIds.includes(chatId.toString())) return bot.sendMessage(chatId, '❌ Unauthorized');

    let code = match[1];
    const limit = parseInt(match[2], 10);

    if (!code) {
        code = generateGiveawayCode();
    }

    if (isNaN(limit)) {
        return bot.sendMessage(chatId, 'Invalid limit. Please provide a number.');
    }

    createGiveaway(code, limit);
    bot.sendMessage(chatId, `✅ Giveaway created!\nCode: ${code}\nLimit: ${limit}`);
});

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    if (data.startsWith('confirm_gift_')) {
        const orderId = data.split('_')[2];
        const giftOrder = await Gift.findOne({ id: orderId });

        if (giftOrder) {
            giftOrder.status = 'completed';
            await giftOrder.save();

            const userMessage = `🎉 Your giveaway order (ID: ${giftOrder.id}) has been confirmed!\n\nYou have received 15 bonus stars. Thank you for using StarStore!`;
            await bot.sendMessage(giftOrder.telegramId, userMessage);

            const adminMessage = `✅ Giveaway Order Confirmed!\n\nOrder ID: ${giftOrder.id}\nUser: @${giftOrder.username} (ID: ${giftOrder.telegramId})\nStars: 15 (Giveaway)\nCode: ${giftOrder.giveawayCode}`;

            for (const adminMessageInfo of giftOrder.adminMessages) {
                try {
                    await bot.editMessageText(adminMessage, {
                        chat_id: adminMessageInfo.adminId,
                        message_id: adminMessageInfo.messageId
                    });
                    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
                        chat_id: adminMessageInfo.adminId,
                        message_id: adminMessageInfo.messageId
                    });
                } catch (err) {
                    console.error(`Failed to update message for admin ${adminMessageInfo.adminId}:`, err);
                }
            }

            bot.answerCallbackQuery(query.id, { text: 'Giveaway order confirmed' });
        }
    } else if (data.startsWith('decline_gift_')) {
        const orderId = data.split('_')[2];
        const giftOrder = await Gift.findOne({ id: orderId });

        if (giftOrder) {
            giftOrder.status = 'declined';
            await giftOrder.save();

            const userMessage = `❌ Your giveaway order (ID: ${giftOrder.id}) has been declined.\n\nPlease contact support if you believe this is a mistake.`;
            await bot.sendMessage(giftOrder.telegramId, userMessage);

            const adminMessage = `❌ Giveaway Order Declined!\n\nOrder ID: ${giftOrder.id}\nUser: @${giftOrder.username} (ID: ${giftOrder.telegramId})\nStars: 15 (Giveaway)\nCode: ${giftOrder.giveawayCode}`;

            for (const adminMessageInfo of giftOrder.adminMessages) {
                try {
                    await bot.editMessageText(adminMessage, {
                        chat_id: adminMessageInfo.adminId,
                        message_id: adminMessageInfo.messageId
                    });
                    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
                        chat_id: adminMessageInfo.adminId,
                        message_id: adminMessageInfo.messageId
                    });
                } catch (err) {
                    console.error(`Failed to update message for admin ${adminMessageInfo.adminId}:`, err);
                }
            }

            bot.answerCallbackQuery(query.id, { text: 'Giveaway order declined' });
        }
    }
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text;

    if (!text) return;

    const giveaway = await Giveaway.findOne({ code: text, status: 'active' });

    if (giveaway) {
        if (giveaway.users.includes(userId)) {
            bot.sendMessage(chatId, 'You have already claimed this code.');
            return;
        }

        if (giveaway.claimed >= giveaway.limit) {
            bot.sendMessage(chatId, 'This code has reached its claim limit.');
            return;
        }

        if (new Date() > giveaway.expiresAt) {
            giveaway.status = 'expired';
            await giveaway.save();
            bot.sendMessage(chatId, 'This code has expired.');
            return;
        }

        giveaway.claimed += 1;
        giveaway.users.push(userId);
        await giveaway.save();

        bot.sendMessage(chatId, '🎉 You have successfully claimed the giveaway! You will receive 15 stars when you buy any package.');
    }
});

function expireGiveaways() {
    const now = new Date();
    Giveaway.updateMany({ status: 'active', expiresAt: { $lt: now } }, { status: 'expired' }).exec();
}

setInterval(expireGiveaways, 60 * 60 * 1000);

async function sendStarsBack(telegramId, stars) {
    try {
        const response = await axios.post(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
            chat_id: telegramId,
            text: `You have received ${stars} Telegram Stars as a refund.`,
        });

        if (response.data.ok) {
            return true;
        } else {
            throw new Error(response.data.description || "Failed to send stars back.");
        }
    } catch (err) {
        console.error("Error sending stars back:", err);
        throw err;
    }
}

bot.onText(/\/reverse (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const orderId = match[1].trim();

    const order = await SellOrder.findOne({ id: orderId, telegramId: chatId });

    if (!order) {
        return bot.sendMessage(chatId, "❌ Order not found or you are not the owner of this order.");
    }

    if (order.status !== "pending") {
        return bot.sendMessage(chatId, `❌ This order cannot be reversed because it is already ${order.status}.`);
    }

    if (!order.reversible) {
        return bot.sendMessage(chatId, "❌ This order is not reversible.");
    }

    const reversalRequest = new ReverseOrder({
        id: generateOrderId(),
        originalOrderId: order.id,
        telegramId: chatId,
        username: order.username,
        stars: order.stars,
        status: "pending",
        dateRequested: new Date()
    });

    await reversalRequest.save();

    bot.sendMessage(chatId, `🔄 Reversal request submitted for order ID: ${order.id}. Waiting for admin approval.`);

    const adminMessage = `🔄 New Reversal Request!\n\nReversal ID: ${reversalRequest.id}\nOrder ID: ${order.id}\nUser: @${order.username}\nStars: ${order.stars}`;
    const adminKeyboard = {
        inline_keyboard: [
            [
                { text: "✅ Approve", callback_data: `approve_reversal_${reversalRequest.id}` },
                { text: "❌ Decline", callback_data: `decline_reversal_${reversalRequest.id}` },
            ],
        ],
    };

    for (const adminId of adminIds) {
        try {
            await bot.sendMessage(adminId, adminMessage, { reply_markup: adminKeyboard });
        } catch (err) {
            console.error(`Failed to notify admin ${adminId}:`, err);
        }
    }
});

bot.on("callback_query", async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    if (data.startsWith("approve_reversal_") || data.startsWith("decline_reversal_")) {
        const reversalId = data.split("_")[2];

        const reversalRequest = await ReverseOrder.findOne({ id: reversalId });

        if (!reversalRequest) {
            return bot.answerCallbackQuery(query.id, { text: "Reversal request not found." });
        }

        const originalOrder = await SellOrder.findOne({ id: reversalRequest.originalOrderId });

        if (!originalOrder) {
            return bot.answerCallbackQuery(query.id, { text: "Original order not found." });
        }

        if (data.startsWith("approve_reversal_")) {
            try {
                await sendStarsBack(reversalRequest.telegramId, reversalRequest.stars);
            } catch (err) {
                console.error("Failed to send stars back:", err);
                return bot.answerCallbackQuery(query.id, { text: "Failed to send stars back. Please try again." });
            }

            reversalRequest.status = "approved";
            reversalRequest.dateApproved = new Date();
            await reversalRequest.save();

            originalOrder.status = "reversed";
            originalOrder.dateReversed = new Date();
            await originalOrder.save();

            const userMessage = `✅ Your reversal request for order ID: ${originalOrder.id} has been approved. ${reversalRequest.stars} stars have been refunded.`;
            await bot.sendMessage(reversalRequest.telegramId, userMessage);

            const adminMessage = `✅ Reversal Approved!\n\nReversal ID: ${reversalRequest.id}\nOrder ID: ${originalOrder.id}\nUser: @${originalOrder.username}\nStars: ${originalOrder.stars}`;
            await bot.sendMessage(chatId, adminMessage);

            bot.answerCallbackQuery(query.id, { text: "Reversal approved." });
        } else if (data.startsWith("decline_reversal_")) {
            reversalRequest.status = "declined";
            reversalRequest.dateDeclined = new Date();
            await reversalRequest.save();

            const userMessage = `❌ Your reversal request for order ID: ${originalOrder.id} has been declined.`;
            await bot.sendMessage(reversalRequest.telegramId, userMessage);

            const adminMessage = `❌ Reversal Declined!\n\nReversal ID: ${reversalRequest.id}\nOrder ID: ${originalOrder.id}\nUser: @${originalOrder.username}\nStars: ${originalOrder.stars}`;
            await bot.sendMessage(chatId, adminMessage);

            bot.answerCallbackQuery(query.id, { text: "Reversal declined." });
        }

        try {
            await bot.editMessageReplyMarkup(
                { inline_keyboard: [] },
                {
                    chat_id: chatId,
                    message_id: query.message.message_id,
                }
            );
        } catch (err) {
            console.error("Failed to edit message reply markup:", err);
        }
    }
});

const fetch = require('node-fetch');

setInterval(() => {
  fetch('https://tg-star-store-production.up.railway.app')
    .then(response => console.log('Ping successful'))
    .catch(err => console.error('Ping failed:', err));
}, 4 * 60 * 1000);

const PORT = process.env.PORT || 3000;


app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
