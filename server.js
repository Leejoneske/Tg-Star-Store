require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const axios = require('axios');


const app = express();
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());


const buyOrdersFilePath = path.join(__dirname, 'buyOrders.json');
const sellOrdersFilePath = path.join(__dirname, 'sellOrders.json');
const usersFilePath = path.join(__dirname, 'users.json');
const notificationsFilePath = path.join(__dirname, 'notifications.json');
const referralsFilePath = path.join(__dirname, 'referrals.json');
const cancelledOrdersFilePath = path.join(__dirname, 'cancelledOrders.json');
const bannedUsersFilePath = path.join(__dirname, 'bannedUsers.json');
const giveawaysFilePath = path.join(__dirname, 'giveaways.json');
const giftsFilePath = path.join(__dirname, 'gifts.json');

function readDataFromFile(filePath, defaultValue = {}) {
    if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
    return defaultValue;
}

function writeDataToFile(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

let buyOrdersData = readDataFromFile(buyOrdersFilePath, { orders: [] });
let sellOrdersData = readDataFromFile(sellOrdersFilePath, { orders: [] });
let usersData = readDataFromFile(usersFilePath, { users: [] });
let notificationsData = readDataFromFile(notificationsFilePath, { notifications: [] });
let referralsData = readDataFromFile(referralsFilePath, { referrals: [] });
let cancelledOrdersData = readDataFromFile(cancelledOrdersFilePath, { orders: [] });
let bannedUsersData = readDataFromFile(bannedUsersFilePath, { users: [] });
let giveawaysData = readDataFromFile(giveawaysFilePath, { giveaways: [] });
let giftsData = readDataFromFile(giftsFilePath, { gifts: [] });

const adminIds = process.env.ADMIN_TELEGRAM_IDS.split(',').map(id => id.trim());

function generateOrderId() {
    return Array.from({ length: 6 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 36)]).join('');
}

// Function to update order messages
async function updateOrderMessages(order, newStatus, reason = '') {
    const statusMessage = newStatus === 'completed' ? '✅ Order Completed' :
                          newStatus === 'declined' ? '❌ Order Declined' :
                          newStatus === 'canceled' ? '❌ Order Canceled' : '🔄 Order Updated';

    const userMessage = `Your order has been updated:\n\nOrder ID: ${order.id}\nStatus: ${statusMessage}\n${reason ? `Reason: ${reason}` : ''}`;
    await bot.sendMessage(order.telegramId, userMessage);

    // Update admin messages
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

        if (bannedUsersData.users.includes(telegramId.toString())) {
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

        const order = {
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
        };

        // Save the order to buyOrders.json
        buyOrdersData.orders.push(order);
        writeDataToFile(buyOrdersFilePath, buyOrdersData);

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

        const referral = referralsData.referrals.find(ref => ref.referredUserId === telegramId);

        if (referral && referral.status === 'pending') {
            referral.status = 'active';
            referral.dateCompleted = new Date();
            writeDataToFile(referralsFilePath, referralsData);

            await bot.sendMessage(
                referral.referrerUserId,
                `🎉 Your referral @${username} has made a purchase! Thank you for bringing them to StarStore.`
            );
        }

        writeDataToFile(buyOrdersFilePath, buyOrdersData);
        res.json({ success: true, order });
    } catch (err) {
        console.error('Order creation error:', err);
        res.status(500).json({ error: 'Failed to create order' });
    }
});

app.post('/api/sell-orders', async (req, res) => {
    try {
        const { telegramId, username, stars, walletAddress } = req.body;

        if (!telegramId || !stars || !walletAddress) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        if (bannedUsersData.users.includes(telegramId.toString())) {
            return res.status(403).json({ error: 'You are banned from placing orders' });
        }

        const order = {
            id: generateOrderId(),
            telegramId,
            username,
            stars,
            walletAddress,
            status: 'pending',
            dateCreated: new Date(),
            adminMessages: []
        };

        // Save the order to sellOrders.json
        sellOrdersData.orders.push(order);
        writeDataToFile(sellOrdersFilePath, sellOrdersData);

        const paymentLink = await createTelegramInvoice(telegramId, order.id, stars, `Purchase of ${stars} Telegram Stars`);

        res.json({ success: true, paymentLink });
    } catch (err) {
        console.error('Sell order creation error:', err);
        res.status(500).json({ error: 'Failed to create sell order' });
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

bot.on('pre_checkout_query', (query) => {
    const orderId = query.invoice_payload;

    // Check sell orders first
    let order = sellOrdersData.orders.find(o => o.id === orderId);

    // If not found in sell orders, check buy orders
    if (!order) {
        order = buyOrdersData.orders.find(o => o.id === orderId);
    }

    if (order) {
        bot.answerPreCheckoutQuery(query.id, true); // Approve the payment
    } else {
        bot.answerPreCheckoutQuery(query.id, false, { error_message: 'Order not found' }); // Reject the payment
    }
});


bot.on('successful_payment', async (msg) => {
    const orderId = msg.successful_payment.invoice_payload;

    // Check sell orders first
    let order = sellOrdersData.orders.find(o => o.id === orderId);

    // If not found in sell orders, check buy orders
    if (!order) {
        order = buyOrdersData.orders.find(o => o.id === orderId);
    }

    if (order) {
        order.status = 'completed';
        order.completedAt = new Date();

        // Save the updated order status
        if (sellOrdersData.orders.includes(order)) {
            writeDataToFile(sellOrdersFilePath, sellOrdersData);
        } else {
            writeDataToFile(buyOrdersFilePath, buyOrdersData);
        }

        const userMessage = `✅ Payment successful!\n\nOrder ID: ${order.id}\nStars: ${order.stars}\nStatus: Completed`;

        // Send the message to the user without the "Cancel Order" button
        await bot.sendMessage(order.telegramId, userMessage);

        // Notify admins about the completed sell order
        const adminMessage = `🛒 Sell Order Completed!\n\nOrder ID: ${order.id}\nUser: @${order.username}\nStars: ${order.stars}\nWallet Address: ${order.walletAddress}`;
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
    } else {
        await bot.sendMessage(msg.chat.id, '❌ Payment was successful, but the order was not found. Please contact support.');
    }
});




bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    const orderId = data.split('_')[1];

    // Check sell orders first
    let order = sellOrdersData.orders.find(o => o.id === orderId);

    // If not found in sell orders, check buy orders
    if (!order) {
        order = buyOrdersData.orders.find(o => o.id === orderId);
    }

    if (!order) {
        bot.answerCallbackQuery(query.id, { text: 'Order not found' });
        return;
    }

    if (data.startsWith('complete_')) {
        order.status = 'completed';
        order.completedAt = new Date();

        // Save the updated order status
        if (sellOrdersData.orders.includes(order)) {
            writeDataToFile(sellOrdersFilePath, sellOrdersData);
        } else {
            writeDataToFile(buyOrdersFilePath, buyOrdersData);
        }

        await updateOrderMessages(order, 'completed');
        bot.answerCallbackQuery(query.id, { text: 'Order marked as completed' });
    } else if (data.startsWith('decline_')) {
        order.status = 'declined';
        order.declinedAt = new Date();

        // Save the updated order status
        if (sellOrdersData.orders.includes(order)) {
            writeDataToFile(sellOrdersFilePath, sellOrdersData);
        } else {
            writeDataToFile(buyOrdersFilePath, buyOrdersData);
        }

        await updateOrderMessages(order, 'declined', 'Order declined by admin');
        bot.answerCallbackQuery(query.id, { text: 'Order declined' });
    }
});

bot.onText(/\/ban (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    if (!adminIds.includes(chatId.toString())) return bot.sendMessage(chatId, '❌ Unauthorized');

    const userId = match[1];
    if (bannedUsersData.users.includes(userId)) {
        bot.sendMessage(chatId, `❌ User ${userId} is already banned.`);
    } else {
        bannedUsersData.users.push(userId);
        writeDataToFile(bannedUsersFilePath, bannedUsersData);

        // Send a graceful ban notification to the user
        const banMessage = `🚫 **Account Suspension Notice**\n\nWe regret to inform you that your account has been suspended due to a violation of our terms of service.\n\nIf you believe this is a mistake, please contact our support team for further assistance.\n\nThank you for your understanding.`;
        bot.sendMessage(userId, banMessage, { parse_mode: 'Markdown' });

        bot.sendMessage(chatId, `✅ User ${userId} has been banned.`);
    }
});

bot.onText(/\/unban (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    if (!adminIds.includes(chatId.toString())) return bot.sendMessage(chatId, '❌ Unauthorized');

    const userId = match[1];
    if (!bannedUsersData.users.includes(userId)) {
        bot.sendMessage(chatId, `❌ User ${userId} is not banned.`);
    } else {
        bannedUsersData.users = bannedUsersData.users.filter(id => id !== userId);
        writeDataToFile(bannedUsersFilePath, bannedUsersData);

        // Notify the user that they have been unbanned
        const unbanMessage = `🎉 **Account Reinstated**\n\nWe are pleased to inform you that your account has been reinstated. Welcome back!\n\nThank you for your patience and understanding.`;
        bot.sendMessage(userId, unbanMessage, { parse_mode: 'Markdown' });

        bot.sendMessage(chatId, `✅ User ${userId} has been unbanned.`);
    }
});

bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const username = msg.from.username;

    if (!Array.isArray(usersData.users)) {
        usersData.users = [];
    }

    if (!usersData.users.some(user => user.id === chatId)) {
        usersData.users.push({ id: chatId, username });
        writeDataToFile(usersFilePath, usersData);
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
        for (const user of usersData.users) {
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

app.get('/api/notifications', (req, res) => {
    res.json({ notifications: notificationsData.notifications });
});

bot.onText(/\/notify (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    if (!adminIds.includes(chatId.toString())) {
        bot.sendMessage(chatId, '❌ Unauthorized: Only admins can use this command.');
        return;
    }

    const notificationMessage = match[1];
    const timestamp = new Date().toLocaleTimeString();

    notificationsData.notifications = [{ message: notificationMessage, timestamp }];
    writeDataToFile(notificationsFilePath, notificationsData);

    bot.sendMessage(chatId, `✅ Notification sent at ${timestamp}:\n\n${notificationMessage}`)
        .catch(err => {
            console.error('Failed to send confirmation to admin:', err);
            bot.sendMessage(chatId, '❌ Failed to send notification.');
        });
});

app.get('/api/transactions/:userId', (req, res) => {
    const userId = req.params.userId;
    const buyOrdersData = readDataFromFile(buyOrdersFilePath, { orders: [] });
    const sellOrdersData = readDataFromFile(sellOrdersFilePath, { orders: [] });

    const userTransactions = [...buyOrdersData.orders, ...sellOrdersData.orders].filter(order => order.telegramId.toString() === userId);
    const sortedTransactions = userTransactions.sort((a, b) => new Date(b.dateCreated) - new Date(a.dateCreated));

    res.json(sortedTransactions);
});

app.get('/api/referrals/:userId', (req, res) => {
    const userId = req.params.userId;
    const referralsData = readDataFromFile(referralsFilePath, { referrals: [] });

    const userReferrals = referralsData.referrals.filter(ref => ref.referrerUserId === userId);
    const sortedReferrals = userReferrals.sort((a, b) => new Date(b.dateReferred) - new Date(a.dateReferred));
    const latestReferrals = sortedReferrals.slice(0, 3);

    const activeReferrals = userReferrals.filter(ref => ref.status === 'active').length;
    const pendingReferrals = userReferrals.filter(ref => ref.status === 'pending').length;

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

app.post('/api/orders/create', async (req, res) => {
    try {
        const { telegramId, username, stars, walletAddress, isPremium, premiumDuration } = req.body;

        // Calculate the amount based on the package type
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

        // Existing order creation logic (unchanged)
        const order = {
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
        };

        buyOrdersData.orders.push(order);
        writeDataToFile(buyOrdersFilePath, buyOrdersData);

        // Check if the user has an active giveaway
        const giveaway = giveawaysData.giveaways.find(g => g.users.includes(telegramId) && g.status === 'active');
if (giveaway) {
    // Create a separate giveaway order in gifts.json
    const giftOrder = {
        id: generateOrderId(),
        telegramId,
        username,
        stars: 15, // Giveaway stars
        walletAddress,
        status: 'pending', // Admins must confirm
        dateCreated: new Date(),
        adminMessages: [], // Store message IDs for each admin
        giveawayCode: giveaway.code // Track which code was used
    };

    giftsData.gifts.push(giftOrder);
    writeDataToFile(giftsFilePath, giftsData);

    // Notify the user
    const userMessage = `🎉 You have received 15 bonus stars from the giveaway!\n\n` +
                       `Your giveaway order (ID: ${giftOrder.id}) is pending admin approval.`;
    await bot.sendMessage(telegramId, userMessage);

    // Notify admins with confirm/decline buttons
    const adminMessage = `🎉 New Giveaway Order!\n\n` +
                        `Order ID: ${giftOrder.id}\n` +
                        `User: @${username} (ID: ${telegramId})\n` +
                        `Stars: 15 (Giveaway)\n` +
                        `Code: ${giveaway.code}`;

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
            giftOrder.adminMessages.push({ adminId, messageId: message.message_id }); // Store message ID for this admin
        } catch (err) {
            console.error(`Failed to send message to admin ${adminId}:`, err);
        }
    }

    // Mark the giveaway as completed for this user
    giveaway.status = 'completed';
    writeDataToFile(giveawaysFilePath, giveawaysData);
}

        // Continue with the existing order creation logic
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
        const order = buyOrdersData.orders.find(o => o.id === orderId);

        if (order) {
            order.status = 'completed';
            order.completedAt = new Date();
            writeDataToFile(buyOrdersFilePath, buyOrdersData);

            // Notify the user
            const userMessage = `✅ Your order (ID: ${order.id}) has been confirmed!\n\n` +
                               `Thank you for using StarStore!`;
            await bot.sendMessage(order.telegramId, userMessage);

            // Check if the user has an active giveaway
            const giveaway = giveawaysData.giveaways.find(g => g.users.includes(order.telegramId) && g.status === 'active');

            if (giveaway) {
                // Create a separate giveaway order in gifts.json
                const giftOrder = {
                    id: generateOrderId(),
                    telegramId: order.telegramId,
                    username: order.username,
                    stars: 15, // Giveaway stars
                    walletAddress: order.walletAddress,
                    status: 'pending', // Admins must confirm
                    dateCreated: new Date(),
                    adminMessages: [],
                    giveawayCode: giveaway.code // Track which code was used
                };

                giftsData.gifts.push(giftOrder);
                writeDataToFile(giftsFilePath, giftsData);

                // Notify the user
                const userGiftMessage = `🎉 You have received 15 bonus stars from the giveaway!\n\n` +
                                       `Your giveaway order (ID: ${giftOrder.id}) is pending admin approval.`;
                await bot.sendMessage(order.telegramId, userGiftMessage);

                // Notify admins with confirm/decline buttons
                const adminGiftMessage = `🎉 New Giveaway Order!\n\n` +
                                        `Order ID: ${giftOrder.id}\n` +
                                        `User: @${order.username} (ID: ${order.telegramId})\n` +
                                        `Stars: 15 (Giveaway)\n` +
                                        `Code: ${giveaway.code}`;

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

                // Mark the giveaway as completed for this user
                giveaway.status = 'completed';
                writeDataToFile(giveawaysFilePath, giveawaysData);
            }

            // Notify admins about the regular order confirmation
            const adminMessage = `✅ Order Confirmed!\n\n` +
                                `Order ID: ${order.id}\n` +
                                `User: @${order.username} (ID: ${order.telegramId})\n` +
                                `Amount: ${order.amount} USDT\n` +
                                `Status: Completed`;

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
        const order = buyOrdersData.orders.find(o => o.id === orderId);

        if (order) {
            order.status = 'declined';
            order.declinedAt = new Date();
            writeDataToFile(buyOrdersFilePath, buyOrdersData);

            // Notify the user
            const userMessage = `❌ Your order (ID: ${order.id}) has been declined.\n\n` +
                               `Please contact support if you believe this is a mistake.`;
            await bot.sendMessage(order.telegramId, userMessage);

            // Check if the user has an active giveaway
            const giveaway = giveawaysData.giveaways.find(g => g.users.includes(order.telegramId) && g.status === 'active');

            if (giveaway) {
                // Mark the giveaway as rejected
                giveaway.status = 'rejected';
                writeDataToFile(giveawaysFilePath, giveawaysData);

                // Notify the user
                const userGiftMessage = `❌ Your giveaway code (${giveaway.code}) has been rejected because your order was declined.`;
                await bot.sendMessage(order.telegramId, userGiftMessage);
            }

            // Notify admins about the regular order decline
            const adminMessage = `❌ Order Declined!\n\n` +
                                `Order ID: ${order.id}\n` +
                                `User: @${order.username} (ID: ${order.telegramId})\n` +
                                `Amount: ${order.amount} USDT\n` +
                                `Status: Declined`;

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
    const giveaway = {
        code,
        limit,
        claimed: 0,
        users: [], // Users who claimed this code
        status: 'active', // Can be 'active', 'used', or 'expired'
        createdAt: new Date(),
        expiresAt: new Date(new Date().getTime() + 30 * 24 * 60 * 60 * 1000) // Expires in 30 days
    };

    giveawaysData.giveaways.push(giveaway);
    writeDataToFile(giveawaysFilePath, giveawaysData);
}

function generateGiveawayCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase(); // e.g., "A1B2C3"
}

bot.onText(/\/create_giveaway(?: (.+) (.+))?/, (msg, match) => {
    const chatId = msg.chat.id;
    if (!adminIds.includes(chatId.toString())) return bot.sendMessage(chatId, '❌ Unauthorized');

    let code = match[1]; // Admin-provided code
    const limit = parseInt(match[2], 10); // Claim limit

    if (!code) {
        code = generateGiveawayCode(); // Auto-generate code if not provided
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
        const giftOrder = giftsData.gifts.find(o => o.id === orderId);

        if (giftOrder) {
            // Step 1: Update the giveaway order status
            giftOrder.status = 'completed';
            writeDataToFile(giftsFilePath, giftsData);

            // Step 2: Notify the user
            const userMessage = `🎉 Your giveaway order (ID: ${giftOrder.id}) has been confirmed!\n\n` +
                               `You have received 15 bonus stars. Thank you for using StarStore!`;
            await bot.sendMessage(giftOrder.telegramId, userMessage);

            // Step 3: Notify admins and remove buttons
            const adminMessage = `✅ Giveaway Order Confirmed!\n\n` +
                                 `Order ID: ${giftOrder.id}\n` +
                                 `User: @${giftOrder.username} (ID: ${giftOrder.telegramId})\n` +
                                 `Stars: 15 (Giveaway)\n` +
                                 `Code: ${giftOrder.giveawayCode}`;

            for (const adminMessageInfo of giftOrder.adminMessages) {
                try {
                    // Edit the message for this admin
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
        const giftOrder = giftsData.gifts.find(o => o.id === orderId);

        if (giftOrder) {
            // Step 1: Update the giveaway order status
            giftOrder.status = 'declined';
            writeDataToFile(giftsFilePath, giftsData);

            // Step 2: Notify the user
            const userMessage = `❌ Your giveaway order (ID: ${giftOrder.id}) has been declined.\n\n` +
                               `Please contact support if you believe this is a mistake.`;
            await bot.sendMessage(giftOrder.telegramId, userMessage);

            // Step 3: Notify admins and remove buttons
            const adminMessage = `❌ Giveaway Order Declined!\n\n` +
                                 `Order ID: ${giftOrder.id}\n` +
                                 `User: @${giftOrder.username} (ID: ${giftOrder.telegramId})\n` +
                                 `Stars: 15 (Giveaway)\n` +
                                 `Code: ${giftOrder.giveawayCode}`;

            for (const adminMessageInfo of giftOrder.adminMessages) {
                try {
                    // Edit the message for this admin
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

    const giveaway = giveawaysData.giveaways.find(g => g.code === text && g.status === 'active');

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
            writeDataToFile(giveawaysFilePath, giveawaysData);
            bot.sendMessage(chatId, 'This code has expired.');
            return;
        }

        giveaway.claimed += 1;
        giveaway.users.push(userId);
        writeDataToFile(giveawaysFilePath, giveawaysData);

        bot.sendMessage(chatId, '🎉 You have successfully claimed the giveaway! You will receive 15 stars when you buy any package.');
    }
});

function expireGiveaways() {
    const now = new Date();
    giveawaysData.giveaways.forEach(giveaway => {
        if (giveaway.status === 'active' && now > giveaway.expiresAt) {
            giveaway.status = 'expired';
        }
    });
    writeDataToFile(giveawaysFilePath, giveawaysData);
}

// Run every hour
setInterval(expireGiveaways, 60 * 60 * 1000);



const fetch = require('node-fetch');

setInterval(() => {
  fetch('https://google.com')
    .then(response => console.log('Ping successful'))
    .catch(err => console.error('Ping failed:', err));
}, 4 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
