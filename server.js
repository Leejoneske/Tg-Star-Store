require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const axios = require('axios');

const app = express();
const bot = new TelegramBot(process.env.BOT_TOKEN, { webHook: true });

const SERVER_URL = process.env.RAILWAY_STATIC_URL || 
                   process.env.RAILWAY_PUBLIC_DOMAIN || 
                   'https://tg-star-store-production.up.railway.app';

const WEBHOOK_PATH = '/telegram-webhook';
const WEBHOOK_URL = `${SERVER_URL}${WEBHOOK_PATH}`;

bot.setWebHook(WEBHOOK_URL).then(success => {
  console.log('Webhook set success:', success);
  console.log('Webhook URL:', WEBHOOK_URL);
}).catch(err => {
  console.error('Webhook setup failed:', err);
});

app.use(express.static('public'));
app.use(express.json());
app.post(WEBHOOK_PATH, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

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
    users: [{
        userId: String,
        status: { type: String, default: 'pending' }
    }],
    status: { type: String, default: 'active' },
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

const botBalanceSchema = new mongoose.Schema({
    id: { type: String, default: "bot", unique: true }, 
    balance: { type: Number, default: 0 } 
});

const cacheSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    username: { type: String, required: true },
    date: { type: Date, default: Date.now }
});

const claimSchema = new mongoose.Schema({
  claimCode: { type: String, unique: true },
  adminId: Number,
  userId: Number,
  username: String,
  wallet: String,
  expiresAt: { 
    type: Date, 
    default: () => new Date(Date.now() + 24 * 60 * 60 * 1000), 
    expires: 0 
  }
});

const Claim = mongoose.model('Claim', claimSchema);
const Cache = mongoose.model('Cache', cacheSchema);
const BotBalance = mongoose.model('BotBalance', botBalanceSchema);
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
// Wallet Address Endpoint
app.get('/api/get-wallet-address', (req, res) => {
    try {
        const walletAddress = process.env.WALLET_ADDRESS;
        
        if (!walletAddress) {
            return res.status(500).json({
                success: false,
                error: 'Wallet address not configured'
            });
        }

        res.json({
            success: true,
            walletAddress: walletAddress
        });
    } catch (error) {
        console.error('Error getting wallet address:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});


// ===== BUY ORDER CODE WITH FIXED BUTTONS ====
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
            regular: { 1000: 20, 500: 10, 100: 2, 50: 1, 25: 0.6, 15: 0.35 },
            premium: { 3: 19.31, 6: 26.25, 12: 44.79 }
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
            `🛒 New Buy Order!\n\nOrder ID: ${order.id}\nUser: @${username}\nAmount: ${amount} USDT\nStars: ${stars}`;

        const adminKeyboard = {
            inline_keyboard: [[
                { text: '✅ Complete', callback_data: `complete_${order.id}` },
                { text: '❌ Decline', callback_data: `decline_${order.id}` }
            ]]
        };

        for (const adminId of adminIds) {
            try {
                const message = await bot.sendMessage(adminId, adminMessage, { reply_markup: adminKeyboard });
                order.adminMessages.push({ 
                    adminId, 
                    messageId: message.message_id,
                    originalText: adminMessage 
                });
            } catch (err) {
                console.error(`Failed to notify admin ${adminId}:`, err);
            }
        }

        await order.save();
        res.json({ success: true, order });
    } catch (err) {
        console.error('Order creation error:', err);
        res.status(500).json({ error: 'Failed to create order' });
    }
});

bot.on('callback_query', async (query) => {
    try {
        const action = query.data;
        const [actionType, orderId] = action.split('_');
        const order = await BuyOrder.findOne({ id: orderId });

        if (!order || order.status !== 'pending') {
            await bot.answerCallbackQuery(query.id);
            return;
        }

        if (actionType === 'complete') {
            order.status = 'completed';
            order.dateCompleted = new Date();
            
            const referral = await Referral.findOne({ 
                referredUserId: order.telegramId,
                status: 'pending'
            });
            
            if (referral) {
                referral.status = 'active';
                referral.dateCompleted = new Date();
                await referral.save();
                
                await bot.sendMessage(
                    referral.referrerUserId,
                    `🎉 Your referral @${order.username} has made a purchase!`
                );
            }
            
        } else if (actionType === 'decline') {
            order.status = 'declined';
            order.dateDeclined = new Date();
        }

        await order.save();

        for (const adminMsg of order.adminMessages) {
            try {
                const statusText = order.status === 'completed' ? '✓ Confirmed' : '✗ Declined';
                await bot.editMessageText(
                    `${adminMsg.originalText}\n\nStatus: ${statusText}`,
                    {
                        chat_id: adminMsg.adminId,
                        message_id: adminMsg.messageId,
                        reply_markup: {
                            inline_keyboard: [[
                                { text: statusText, callback_data: 'processed' }
                            ]]
                        }
                    }
                );
            } catch (err) {
                console.error(`Failed to update admin ${adminMsg.adminId}:`, err);
            }
        }

        const userMessage = order.status === 'completed' ?
            `✅ Order #${order.id} confirmed!\n\nThank you for your purchase!` :
            `❌ Order #${order.id} declined\n\nContact support if needed.`;
        
        await bot.sendMessage(order.telegramId, userMessage);

        await bot.answerCallbackQuery(query.id);

    } catch (err) {
        console.error('Button handler error:', err);
        await bot.answerCallbackQuery(query.id);
    }
});
//end of buy order and referral check 

// ===== SELL ORDER CONTROLLER =====
app.post("/api/sell-orders", async (req, res) => {
    try {
        // ===== INPUT VALIDATION =====
        const { telegramId, username, stars, walletAddress } = req.body;
        if (!telegramId || !stars || !walletAddress) {
            return res.status(400).json({ error: "Missing required fields" });
        }

        // ===== BAN CHECK =====
        const bannedUser = await BannedUser.findOne({ users: telegramId.toString() });
        if (bannedUser) {
            return res.status(403).json({ error: "You are banned from placing orders" });
        }

        // ===== ORDER CREATION =====
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

        // ===== PAYMENT LINK GENERATION =====
        const paymentLink = await createTelegramInvoice(telegramId, order.id, stars, `Purchase of ${stars} Telegram Stars`);
        if (!paymentLink) {
            return res.status(500).json({ error: "Failed to generate payment link" });
        }

        // ===== USER NOTIFICATION =====
        const userMessage = `🚀 Sell order initialized!\n\nOrder ID: ${order.id}\nStars: ${order.stars}\nStatus: Pending (Waiting for payment)\n\nPay here: ${paymentLink}`;
        await bot.sendMessage(telegramId, userMessage);

        res.json({ success: true, order, paymentLink });
    } catch (err) {
        console.error("Sell order creation error:", err);
        res.status(500).json({ error: "Failed to create sell order" });
    }
});

// ===== PAYMENT VERIFICATION HANDLER =====
bot.on('pre_checkout_query', async (query) => {
    const orderId = query.invoice_payload;
    const order = await SellOrder.findOne({ id: orderId }) || await BuyOrder.findOne({ id: orderId });
    await bot.answerPreCheckoutQuery(query.id, !!order);
});

// ===== PAYMENT SUCCESS HANDLER =====
bot.on("successful_payment", async (msg) => {
    const orderId = msg.successful_payment.invoice_payload;
    const order = await SellOrder.findOne({ id: orderId });

    if (!order) {
        return await bot.sendMessage(msg.chat.id, "❌ Payment was successful, but the order was not found. Please contact support.");
    }

    // ===== ORDER STATUS UPDATE =====
    order.status = "processing"; 
    order.datePaid = new Date();
    await order.save();

    // ===== USER NOTIFICATION =====
    await bot.sendMessage(
        order.telegramId,
        `✅ Payment successful!\n\nOrder ID: ${order.id}\nStars: ${order.stars}\nStatus: Processing (Under admin review)`
    );

    // ===== ADMIN NOTIFICATION =====
    const adminMessage = `💰 New Payment Received!\n\n` +
        `Order ID: ${order.id}\n` +
        `User: @${order.username} (ID: ${order.telegramId})\n` + 
        `Stars: ${order.stars}\n` +
        `Wallet: \`${order.walletAddress}\``;

    const adminKeyboard = {
        inline_keyboard: [
            [
                { text: "✅ Complete", callback_data: `complete_sell_${order.id}` },
                { text: "❌ Decline", callback_data: `decline_sell_${order.id}` }
            ]
        ]
    };

    for (const adminId of adminIds) {
        try {
            const message = await bot.sendMessage(
                adminId,
                adminMessage,
                { 
                    reply_markup: adminKeyboard,
                    parse_mode: "Markdown"
                }
            );
            order.adminMessages.push({ 
                adminId, 
                messageId: message.message_id,
                originalText: adminMessage 
            });
            await order.save();
        } catch (err) {
            console.error(`Failed to notify admin ${adminId}:`, err);
        }
    }
});
// ===== ADMIN ACTION HANDLER (RESTORED WORKING VERSION) =====
bot.on('callback_query', async (query) => {
    try {
        const data = query.data;
        let order, actionType;

        // Handle both sell and buy orders
        if (data.startsWith('complete_sell_')) {
            actionType = 'complete';
            order = await SellOrder.findOne({ id: data.split('_')[2] });
        } else if (data.startsWith('decline_sell_')) {
            actionType = 'decline';
            order = await SellOrder.findOne({ id: data.split('_')[2] });
        } else if (data.startsWith('complete_buy_')) {
            actionType = 'complete';
            order = await BuyOrder.findOne({ id: data.split('_')[2] });
        } else if (data.startsWith('decline_buy_')) {
            actionType = 'decline';
            order = await BuyOrder.findOne({ id: data.split('_')[2] });
        } else {
            return await bot.answerCallbackQuery(query.id);
        }

        // Check if order exists and is in correct status
        if (!order || (order.status !== 'processing' && order.status !== 'pending')) {
            await bot.answerCallbackQuery(query.id, { text: "Order not found or already processed" });
            return;
        }

        // Process completion or declination
        if (actionType === 'complete') {
            // ===== ORDER COMPLETION LOGIC =====
            order.status = 'completed';
            order.completedAt = new Date();
            await order.save();

            // Notify user
            await bot.sendMessage(
                order.telegramId,
                `✅ Order #${order.id} completed!\n\n` +
                `Your ${order.stars} stars have been processed.\n` +
                `Funds sent to: \`${order.walletAddress}\``,
                { parse_mode: "Markdown" }
            );
        } else {
            // ===== ORDER DECLINATION LOGIC =====
            order.status = 'declined';
            order.declinedAt = new Date();
            await order.save();

            // Notify user
            await bot.sendMessage(
                order.telegramId,
                `❌ Order #${order.id} declined\n\n` +
                `Please contact support for resolution.`,
                { parse_mode: "Markdown" }
            );
        }

        // ===== UPDATE ADMIN MESSAGES =====
        for (const adminMsg of order.adminMessages) {
            try {
                const statusText = order.status === 'completed' ? '✓ Completed' : '✗ Declined';
                await bot.editMessageText(
                    `${adminMsg.originalText}\n\nStatus: ${statusText}`,
                    {
                        chat_id: adminMsg.adminId,
                        message_id: adminMsg.messageId,
                        reply_markup: {
                            inline_keyboard: [[
                                { text: statusText, callback_data: 'processed' }
                            ]]
                        },
                        parse_mode: "Markdown"
                    }
                );
            } catch (err) {
                console.error(`Failed to update admin ${adminMsg.adminId}:`, err);
            }
        }

        await bot.answerCallbackQuery(query.id, { text: `Order ${order.status}` });
    } catch (err) {
        console.error('Error processing order action:', err);
        await bot.answerCallbackQuery(query.id, { text: "Error processing request" });
    }
});


// ===== INVOICE GENERATION (UNCHANGED) =====
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
 //end of sell process       
        
// quarry database to get sell order for sell page
app.get("/api/sell-orders", async (req, res) => {
    try {
        const { telegramId } = req.query;

        if (!telegramId) {
            return res.status(400).json({ error: "Missing telegramId" });
        }

        const transactions = await SellOrder.find({ telegramId })
            .sort({ dateCreated: -1 }) 
            .limit(3); 

        res.json(transactions);
    } catch (err) {
        console.error("Error fetching transactions:", err);
        res.status(500).json({ error: "Failed to fetch transactions" });
    }
});


bot.onText(/\/ban(?:\s+(\d+))(?:\s+(.+?))?(?:\s+--duration=(\d+)([ymd]))?(?:\s+--ref=(\S+))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const requesterId = msg.from.id.toString();

    // Authorization check
    if (!isAuthorized(requesterId)) {
        return bot.sendMessage(chatId, '⛔ **Access Denied**\n\nYou lack the required permissions to execute this command.', {
            parse_mode: 'Markdown',
            reply_to_message_id: msg.message_id
        });
    }

    if (!match[1]) {
        return sendUsageExample(chatId, msg.message_id);
    }

    const userId = match[1];
    const reason = match[2] || 'Violation of terms of service';
    const durationValue = match[3] ? parseInt(match[3]) : null;
    const durationUnit = match[4] || null;
    const reference = match[5] || null;

    // Calculate ban duration in days
    let durationDays = null;
    if (durationValue) {
        switch(durationUnit) {
            case 'y': durationDays = durationValue * 365; break;
            case 'm': durationDays = durationValue * 30; break;
            case 'd': durationDays = durationValue; break;
            default: durationDays = durationValue;
        }
    }

    // Prevent self-ban and admin ban
    if (userId === requesterId) {
        return bot.sendMessage(chatId, '❌ You cannot ban yourself.', {
            reply_to_message_id: msg.message_id
        });
    }

    if (adminIds.includes(userId)) {
        return bot.sendMessage(chatId, '❌ Cannot ban another administrator.', {
            reply_to_message_id: msg.message_id
        });
    }

    // Check existing ban
    const existingBan = await BannedUser.findOne({ userId });
    if (existingBan) {
        return bot.sendMessage(chatId, `⚠ User ${userId} is already banned.\n\nReason: ${existingBan.reason}\nBanned on: ${existingBan.timestamp.toLocaleString()}\nBy: ${existingBan.bannedBy}`, {
            reply_to_message_id: msg.message_id,
            parse_mode: 'Markdown'
        });
    }

    // Create ban record
    const banExpiry = durationDays ? new Date(Date.now() + durationDays * 86400000) : null;
    const caseNumber = generateCaseNumber('BAN');
    
    const banRecord = {
        userId,
        reason,
        bannedBy: msg.from.username ? `@${msg.from.username}` : msg.from.first_name,
        timestamp: new Date(),
        durationDays,
        expiryDate: banExpiry,
        reference,
        caseNumber,
        active: true
    };

    await BannedUser.create(banRecord);

    // Notify banned user
    try {
        const banMessage = `⚠️ **Account Restriction Notice** [Case ${caseNumber}]\n\n` +
            `After careful review, your account privileges have been temporarily suspended for:\n\n` +
            `▸ **Violation**: ${reason}\n` +
            (durationDays ? `▸ **Restriction Period**: ${formatDuration(durationDays)} (until ${banExpiry.toLocaleDateString()})\n` : '▸ **Restriction Type**: Permanent suspension\n') +
            `\n**Important Notes**:\n` +
            `• You will continue receiving StarStore product updates\n` +
            `• Order placement functionality is disabled\n` +
            `• All pending transactions are frozen\n\n` +
            `If you believe this was made in error, you may submit an appeal through our official channels.`;

        await bot.sendMessage(userId, banMessage, { parse_mode: 'Markdown' });
    } catch (e) {
        console.error('Failed to notify banned user:', e);
    }

    // Confirm to moderator
    const adminMessage = `✅ **Restriction Order Processed** [${caseNumber}]\n` +
        `┌─ User: ${userId}\n` +
        `├─ Type: ${durationDays ? 'Temporary' : 'Permanent'} Suspension\n` +
        (durationDays ? `├─ Duration: ${formatDuration(durationDays)}\n` : '') +
        (reference ? `├─ Reference: ${reference}\n` : '') +
        (banExpiry ? `└─ Auto-Release: ${banExpiry.toLocaleString()}\n` : '└─ No expiration\n');

    await bot.sendMessage(chatId, adminMessage, {
        parse_mode: 'Markdown',
        reply_to_message_id: msg.message_id
    });
});

// Helper functions
function formatDuration(days) {
    if (days >= 365) return `${Math.floor(days/365)} year(s)`;
    if (days >= 30) return `${Math.floor(days/30)} month(s)`;
    return `${days} day(s)`;
}

function generateCaseNumber(prefix) {
    const now = new Date();
    const randomNum = Math.floor(100 + Math.random() * 900);
    return `${prefix}-${now.getFullYear()}${(now.getMonth()+1).toString().padStart(2,'0')}${now.getDate().toString().padStart(2,'0')}-${randomNum}`;
}

function sendUsageExample(chatId, replyTo) {
    return bot.sendMessage(chatId, 
        `⚠ **Usage**: \`/ban <user_id> [reason] [--duration=<value><y|m|d>] [--ref=<reference_code>]\`\n\n` +
        `**Examples**:\n` +
        `• Permanent ban: \`/ban 12345678 Fraudulent activity\`\n` +
        `• 2-year ban: \`/ban 12345678 Scam --duration=2y\`\n` +
        `• With reference: \`/ban 12345678 "Account sharing" --ref=SEC-2025-001\``, 
        {
            parse_mode: 'Markdown',
            reply_to_message_id: replyTo
        }
    );
}

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

//added deep link detection
bot.onText(/\/start(.*)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const username = msg.from.username || 'user';
    const deepLinkParam = match[1]?.trim();
    
    try {
        let user = await User.findOne({ id: chatId });
        
        if (!user) {
            user = await User.create({ id: chatId, username });
        }
        
        const welcomeMessage = `👋 Hello @${username}, welcome to StarStore!\n\nUse the app to purchase stars and enjoy exclusive benefits. 🌟`;
        const keyboard = {
            inline_keyboard: [
                [{ text: 'Launch App', url: `https://t.me/TgStarStore_bot?startapp` }],
                [{ text: 'Join Community', url: `https://t.me/StarsStore_shop` }]
            ]
        };
        
        await bot.sendMessage(chatId, welcomeMessage, { reply_markup: keyboard });

        // ===== CLAIM CODE HANDLING =====
        if (deepLinkParam && deepLinkParam.startsWith('CLAIM_')) {
            const claim = await Claim.findOne({
                claimCode: deepLinkParam,
                expiresAt: { $gt: new Date() }
            });
            
            if (claim && !claim.userId) {
                await bot.sendMessage(
                    chatId,
                    "💰 Please submit your wallet address to claim your reward:\n\n" +
                    "Type or paste your wallet address now:"
                );
                return; // Stop here to wait for wallet input
            }
        }
        
        if (deepLinkParam && deepLinkParam.startsWith('ref_')) {
            const referrerUserId = deepLinkParam.split('_')[1];
            
            if (!referrerUserId || !/^\d+$/.test(referrerUserId)) {
                console.error('Invalid referrer ID format:', referrerUserId);
                return;
            }
            
            if (referrerUserId === chatId.toString()) {
                console.log('Self-referral attempt blocked:', chatId);
                return;
            }
            
            const referrer = await User.findOne({ id: referrerUserId });
            if (!referrer) {
                console.error('Referrer not found in database:', referrerUserId);
                return;
            }
            
            const existingReferral = await Referral.findOne({
                referrerUserId: referrerUserId,
                referredUserId: chatId.toString()
            });
            
            if (!existingReferral) {
                const newReferral = new Referral({
                    referrerUserId: referrerUserId,
                    referredUserId: chatId.toString(),
                    status: 'pending',
                    dateCreated: new Date()
                });
                
                await newReferral.save();
                
                bot.sendMessage(referrerUserId, `🎉 A new user has signed up using your referral link! Their user ID: ${chatId}.`);
            }
        }
        
    } catch (error) {
        console.error('Error in start handler:', error);
    }
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

//broadcast now supports rich media text including porn
bot.onText(/\/broadcast/, async (msg) => {
    const chatId = msg.chat.id;

    
    if (!adminIds.includes(chatId.toString())) {
        return bot.sendMessage(chatId, '❌ Unauthorized: Only admins can use this command.');
    }
    await bot.sendMessage(chatId, 'Enter the broadcast message (text, photo, audio, etc.):');

    // Listen for the admin's next message
    bot.once('message', async (adminMsg) => {
        const users = await User.find({});
        let successCount = 0;
        let failCount = 0;

        // Extract media and metadata from the admin's message
        const messageType = adminMsg.photo ? 'photo' :
                           adminMsg.audio ? 'audio' :
                           adminMsg.video ? 'video' :
                           adminMsg.document ? 'document' :
                           'text';

        const caption = adminMsg.caption || '';
        const mediaId = adminMsg.photo ? adminMsg.photo[0].file_id :
                       adminMsg.audio ? adminMsg.audio.file_id :
                       adminMsg.video ? adminMsg.video.file_id :
                       adminMsg.document ? adminMsg.document.file_id :
                       null;

        // Broadcast the message to all kang'ethes
        for (const user of users) {
            try {
                if (messageType === 'text') {
                    // Broadcast text message
                    await bot.sendMessage(user.id, adminMsg.text || caption);
                } else {
                    // Broadcast media message
                    await bot.sendMediaGroup(user.id, [{
                        type: messageType,
                        media: mediaId,
                        caption: caption
                    }]);
                }
                successCount++;
            } catch (err) {
                console.error(`Failed to send broadcast to user ${user.id}:`, err);
                failCount++;
            }
        }

        // Notify the admin about the broadcast result
        bot.sendMessage(chatId, `📢 Broadcast results:\n✅ ${successCount} messages sent successfully\n❌ ${failCount} messages failed to send.`);
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

    await Notification.deleteMany({});
    await Notification.create({ message: notificationMessage, timestamp });

    bot.sendMessage(chatId, `✅ Notification sent at ${timestamp}:\n\n${notificationMessage}`)
        .catch(err => {
            console.error('Failed to send confirmation to admin:', err);
            bot.sendMessage(chatId, '❌ Failed to send notification.');
        });
});

//fetch transactions for history page
app.get('/api/transactions/:userId', async (req, res) => {
    const userId = req.params.userId;
    const buyOrders = await BuyOrder.find({ telegramId: userId });
    const sellOrders = await SellOrder.find({ telegramId: userId });

    const userTransactions = [...buyOrders, ...sellOrders].sort((a, b) => new Date(b.dateCreated) - new Date(a.dateCreated));
    res.json(userTransactions);
});

//get referrals for history and referral page
app.get('/api/referrals/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        const allReferrals = await Referral.find({ referrerUserId: userId }).sort({ dateReferred: -1 });
        const activeReferrals = allReferrals.filter(r => r.status === 'active');
        const activeCount = activeReferrals.length;
        const totalCount = allReferrals.length;
        
        // You need to fetch claimed tiers from somewhere
        const user = await User.findOne({ userId: userId }); // Assuming you have a User model
        const claimedTiers = user?.claimedTiers || [];
        
        // Calculate earned USDT based on claimed tiers instead of just active count
        let earnedUSDT = 0;
        if (claimedTiers.includes(1)) earnedUSDT += 0.5;
        if (claimedTiers.includes(2)) earnedUSDT += 2.0;
        if (claimedTiers.includes(3)) earnedUSDT += 5.0;
        
        const recentReferrals = allReferrals.slice(0, 10).map(r => ({
            name: r.referredUsername || `user_${r.referredUserId.slice(0, 6)}`,
            status: r.status,
            daysAgo: Math.floor((Date.now() - new Date(r.dateReferred)) / (1000 * 60 * 60 * 24))
        }));
        
        res.json({
            activeCount,
            totalCount, 
            earnedUSDT,
            recentReferrals,
            claimedTiers // Add this field
        });
    } catch (error) {
        res.status(500).json({ 
            activeCount: 0,
            totalCount: 0, 
            earnedUSDT: 0,
            recentReferrals: [],
            claimedTiers: [] // Add this field here too
        });
    }
});

// Handle both /referrals command and plain text "referrals"
bot.onText(/\/referrals|referrals/i, async (msg) => {
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

        await bot.sendMessage(chatId, message, { reply_markup: keyboard });
    } else {
        const message = `You have no referrals yet.\n\n🔗 Your Referral Link:\n${referralLink}`;

        const keyboard = {
            inline_keyboard: [
                [{ text: 'Share Referral Link', url: `https://t.me/share/url?url=${encodeURIComponent(referralLink)}` }]
            ]
        };

        await bot.sendMessage(chatId, message, { reply_markup: keyboard });
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



//giveaways
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

    if (!code) code = generateGiveawayCode();
    if (isNaN(limit)) return bot.sendMessage(chatId, 'Invalid limit. Please provide a number.');

    createGiveaway(code, limit);
    bot.sendMessage(chatId, `✅ Giveaway created!\nCode: ${code}\nLimit: ${limit}`);
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    const text = msg.text;

    if (!text) return;

    const giveaway = await Giveaway.findOne({ code: text, status: 'active' });

    if (giveaway) {
        // Check if the user has already claimed the giveaway
        const userClaimed = giveaway.users.some(user => user.userId === userId);
        if (userClaimed) {
            bot.sendMessage(chatId, '❌ You have already claimed this giveaway code.');
            return;
        }

        if (giveaway.claimed >= giveaway.limit) {
            bot.sendMessage(chatId, '❌ This giveaway code has reached its claim limit.');
            return;
        }

        if (new Date() > giveaway.expiresAt) {
            giveaway.status = 'expired';
            await giveaway.save();
            bot.sendMessage(chatId, '❌ This giveaway code has expired.');
            return;
        }

        // Update the giveaway with the new user claim
        giveaway.claimed += 1;
        giveaway.users.push({ userId, status: 'pending' }); 
        await giveaway.save();

        bot.sendMessage(chatId, '🎉 You have successfully claimed the giveaway! You will receive 15 stars when you buy any package.');
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

            // Check if the user has an active giveaway
            const giveaway = await Giveaway.findOne({ 
                users: { $elemMatch: { userId: order.telegramId.toString(), status: 'pending' } },
                status: 'active'
            });

            if (giveaway) {
                // Create a gift order for the giveaway
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

                // Notify the user about the gift order
                const userGiftMessage = `🎉 You have received 15 bonus stars from the giveaway!\n\nYour giveaway order (ID: ${giftOrder.id}) is pending admin approval.`;
                await bot.sendMessage(order.telegramId, userGiftMessage);

                // Notify admins about the new gift order
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

                // Mark the giveaway as complete for this user
                const userIndex = giveaway.users.findIndex(user => user.userId === order.telegramId.toString());
                if (userIndex !== -1) {
                    giveaway.users[userIndex].status = 'completed';
                    await giveaway.save();
                }
            }

            // Notify admins about the completed order
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

            // Check if the user has an active giveaway
            const giveaway = await Giveaway.findOne({ 
                users: { $elemMatch: { userId: order.telegramId.toString(), status: 'pending' } },
                status: 'active'
            });

            if (giveaway) {
                // Mark the giveaway as rejected for this user
                const userIndex = giveaway.users.findIndex(user => user.userId === order.telegramId.toString());
                if (userIndex !== -1) {
                    giveaway.users[userIndex].status = 'rejected';
                    await giveaway.save();
                }

                // Notify the user that their giveaway has been rejected
                const userMessage = `❌ Your giveaway has been rejected because your purchase (Order ID: ${order.id}) was declined.`;
                await bot.sendMessage(order.telegramId, userMessage);
            }

            // Notify admins about the declined order
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

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    if (data.startsWith('confirm_gift_')) {
        const giftOrderId = data.split('_')[2];
        const giftOrder = await Gift.findOne({ id: giftOrderId });

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
        const giftOrderId = data.split('_')[2];
        const giftOrder = await Gift.findOne({ id: giftOrderId });

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

function expireGiveaways() {
    const now = new Date();
    Giveaway.updateMany({ status: 'active', expiresAt: { $lt: now } }, { status: 'expired' }).exec();
}

setInterval(expireGiveaways, 60 * 60 * 1000);

//referral claim request
app.post('/api/claim-reward', async (req, res) => {
    try {
        const { userId, tier, amount } = req.body;

        if (!userId || !tier || !amount) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const user = await User.findOne({ id: userId });
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        const referral = await Referral.findOne({ referrerUserId: userId });
        if (!referral) {
            return res.status(404).json({ error: 'Referral data not found' });
        }

        // Check if the user has already claimed this tier
        if (referral.claimedTiers && referral.claimedTiers.includes(tier)) {
            return res.status(400).json({ error: 'Reward already claimed for this tier' });
        }

        // Check if the user meets the referral count for the tier
        const referralCount = referral.referredUsers?.length || 0;
        const requiredReferrals = tier === 1 ? 3 : tier === 2 ? 9 : 15;

        if (referralCount < requiredReferrals) {
            return res.status(400).json({ error: 'Insufficient referrals to claim this reward' });
        }

        // Create a reward order
        const rewardOrder = new Gift({
            id: generateOrderId(),
            telegramId: userId,
            username: user.username,
            stars: 0, // No stars for referral rewards
            walletAddress: '', // User's wallet address (if available)
            status: 'pending',
            dateCreated: new Date(),
            adminMessages: [],
            giveawayCode: `referral_tier_${tier}`,
            rewardAmount: amount
        });

        await rewardOrder.save();

        // Mark the tier as claimed
        if (!referral.claimedTiers) {
            referral.claimedTiers = [];
        }
        referral.claimedTiers.push(tier);
        await referral.save();

        // Notify admins about the new reward order
        const adminMessage = `🎉 New Referral Reward Order!\n\nOrder ID: ${rewardOrder.id}\nUser: @${user.username} (ID: ${userId})\nTier: ${tier}\nAmount: $${amount}`;

        const adminKeyboard = {
            inline_keyboard: [
                [
                    { text: 'Confirm', callback_data: `confirm_reward_${rewardOrder.id}` },
                    { text: 'Decline', callback_data: `decline_reward_${rewardOrder.id}` }
                ]
            ]
        };

        for (const adminId of adminIds) {
            try {
                const message = await bot.sendMessage(adminId, adminMessage, { reply_markup: adminKeyboard });
                rewardOrder.adminMessages.push({ adminId, messageId: message.message_id });
            } catch (err) {
                console.error(`Failed to send message to admin ${adminId}:`, err);
            }
        }

        res.json({ success: true, order: rewardOrder });
    } catch (err) {
        console.error('Claim reward error:', err);
        res.status(500).json({ error: 'Failed to claim reward' });
    }
});

// Handle admin confirmation/decline of reward orders
app.post('/api/claim-reward', async (req, res) => {
    try {
        const { userId, tier, amount } = req.body;

        if (!userId || !tier || !amount) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const user = await User.findOne({ id: userId });
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        const referral = await Referral.findOne({ referrerUserId: userId });
        if (!referral) {
            return res.status(404).json({ error: 'Referral data not found' });
        }

        if (referral.claimedTiers && referral.claimedTiers.includes(tier)) {
            return res.status(400).json({ error: 'Reward already claimed for this tier' });
        }

        const referralCount = referral.referredUsers?.length || 0;
        const requiredReferrals = tier === 1 ? 3 : tier === 2 ? 9 : 15;

        if (referralCount < requiredReferrals) {
            return res.status(400).json({ error: `You need ${requiredReferrals} referrals to claim this reward` });
        }

        const rewardOrder = new Gift({
            id: generateOrderId(),
            telegramId: userId,
            username: user.username,
            stars: 0,
            walletAddress: '',
            status: 'pending',
            dateCreated: new Date(),
            adminMessages: [],
            giveawayCode: `referral_tier_${tier}`,
            rewardAmount: amount
        });

        await rewardOrder.save();

        if (!referral.claimedTiers) {
            referral.claimedTiers = [];
        }
        referral.claimedTiers.push(tier);
        await referral.save();

        const adminMessage = `🎉 New Referral Reward Order!\n\nOrder ID: ${rewardOrder.id}\nUser: @${user.username} (ID: ${userId})\nTier: ${tier}\nAmount: $${amount}`;

        const adminKeyboard = {
            inline_keyboard: [
                [
                    { text: 'Confirm', callback_data: `confirm_reward_${rewardOrder.id}` },
                    { text: 'Decline', callback_data: `decline_reward_${rewardOrder.id}` }
                ]
            ]
        };

        for (const adminId of adminIds) {
            try {
                const message = await bot.sendMessage(adminId, adminMessage, { reply_markup: adminKeyboard });
                rewardOrder.adminMessages.push({ adminId, messageId: message.message_id });
            } catch (err) {
                console.error(`Failed to send message to admin ${adminId}:`, err);
            }
        }

        res.json({ success: true, order: rewardOrder });
    } catch (err) {
        console.error('Claim reward error:', err);
        res.status(500).json({ error: 'An unexpected error occurred. Please try again later.' });
    }
});

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    if (data.startsWith('confirm_reward_')) {
        const orderId = data.split('_')[2];
        const rewardOrder = await Gift.findOne({ id: orderId });

        if (rewardOrder) {
            rewardOrder.status = 'completed';
            await rewardOrder.save();

            const userMessage = `✅ Your referral reward order (ID: ${rewardOrder.id}) has been confirmed!\n\nYou have received $${rewardOrder.rewardAmount}. Thank you for using StarStore!`;
            await bot.sendMessage(rewardOrder.telegramId, userMessage);

            const adminMessage = `✅ Referral Reward Order Confirmed!\n\nOrder ID: ${rewardOrder.id}\nUser: @${rewardOrder.username} (ID: ${rewardOrder.telegramId})\nAmount: $${rewardOrder.rewardAmount}`;

            for (const adminMessageInfo of rewardOrder.adminMessages) {
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

            bot.answerCallbackQuery(query.id, { text: 'Reward order confirmed' });
        }
    } else if (data.startsWith('decline_reward_')) {
        const orderId = data.split('_')[2];
        const rewardOrder = await Gift.findOne({ id: orderId });

        if (rewardOrder) {
            rewardOrder.status = 'declined';
            await rewardOrder.save();

            const userMessage = `❌ Your referral reward order (ID: ${rewardOrder.id}) has been declined.\n\nPlease contact support if you believe this is a mistake.`;
            await bot.sendMessage(rewardOrder.telegramId, userMessage);

            const adminMessage = `❌ Referral Reward Order Declined!\n\nOrder ID: ${rewardOrder.id}\nUser: @${rewardOrder.username} (ID: ${rewardOrder.telegramId})\nAmount: $${rewardOrder.rewardAmount}`;

            for (const adminMessageInfo of rewardOrder.adminMessages) {
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

            bot.answerCallbackQuery(query.id, { text: 'Reward order declined' });
        }
    }
});
//end of claim request

// Handle orders recreation                     

   bot.onText(/\/cso- (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const orderId = match[1];

    try {
        const order = await SellOrder.findOne({ id: orderId });

        if (order) {
            const userOrderDetails = `Your sell order has been recreated:\n\nID: ${order.id}\nUsername: ${order.username}\nStars: ${order.stars}\nWallet: ${order.walletAddress}\nStatus: ${order.status}\nDate Created: ${order.dateCreated}`;
            bot.sendMessage(order.telegramId, userOrderDetails);

            const adminOrderDetails = `Sell Order Recreated:\n\nID: ${order.id}\nUsername: ${order.username}\nStars: ${order.stars}\nWallet: ${order.walletAddress}\nStatus: ${order.status}\nDate Created: ${order.dateCreated}`;
            bot.sendMessage(chatId, adminOrderDetails);

            const confirmButton = {
                reply_markup: {
                    inline_keyboard: [[{ text: 'Confirm Order', callback_data: `confirm_sell_${order.id}_${chatId}` }]]
                }
            };
            bot.sendMessage(chatId, 'Please confirm the order:', confirmButton);
        } else {
            bot.sendMessage(chatId, 'Order not found. Let\'s create it manually. Please enter the Telegram ID of the user:');

            const handleTelegramId = async (userMsg) => {
                const telegramId = userMsg.text;

                bot.sendMessage(chatId, 'Enter the username of the user:');

                const handleUsername = async (userMsg) => {
                    const username = userMsg.text;

                    bot.sendMessage(chatId, 'Enter the number of stars:');

                    const handleStars = async (userMsg) => {
                        const stars = parseInt(userMsg.text, 10);

                        bot.sendMessage(chatId, 'Enter the wallet address:');

                        const handleWalletAddress = async (userMsg) => {
                            const walletAddress = userMsg.text;

                            const newOrder = new SellOrder({
                                id: orderId,
                                telegramId,
                                username,
                                stars,
                                walletAddress,
                                status: 'pending',
                                reversible: true,
                                dateCreated: new Date(),
                                adminMessages: []
                            });

                            await newOrder.save();

                            const userOrderDetails = `Your sell order has been recreated:\n\nID: ${orderId}\nUsername: ${username}\nStars: ${stars}\nWallet: ${walletAddress}\nStatus: pending\nDate Created: ${new Date()}`;
                            bot.sendMessage(telegramId, userOrderDetails);

                            const adminOrderDetails = `Sell Order Recreated:\n\nID: ${orderId}\nUsername: ${username}\nStars: ${stars}\nWallet: ${walletAddress}\nStatus: pending\nDate Created: ${new Date()}`;
                            bot.sendMessage(chatId, adminOrderDetails);

                            const confirmButton = {
                                reply_markup: {
                                    inline_keyboard: [[{ text: 'Confirm Order', callback_data: `confirm_sell_${orderId}_${chatId}` }]]
                                }
                            };
                            bot.sendMessage(chatId, 'Please confirm the order:', confirmButton);
                        };

                        bot.once('message', handleWalletAddress);
                    };

                    bot.once('message', handleStars);
                };

                bot.once('message', handleUsername);
            };

            bot.once('message', handleTelegramId);
        }
    } catch (error) {
        console.error('Error recreating sell order:', error);
        bot.sendMessage(chatId, 'An error occurred while processing your request.');
    }
});

bot.onText(/\/cbo- (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const orderId = match[1];

    try {
        const order = await BuyOrder.findOne({ id: orderId });

        if (order) {
            const userOrderDetails = `Your buy order has been recreated:\n\nID: ${order.id}\nUsername: ${order.username}\nAmount: ${order.amount}\nStars: ${order.stars}\nWallet: ${order.walletAddress}\nStatus: ${order.status}\nDate Created: ${order.dateCreated}`;
            bot.sendMessage(order.telegramId, userOrderDetails);

            const adminOrderDetails = `Buy Order Recreated:\n\nID: ${order.id}\nUsername: ${order.username}\nAmount: ${order.amount}\nStars: ${order.stars}\nWallet: ${order.walletAddress}\nStatus: ${order.status}\nDate Created: ${order.dateCreated}`;
            bot.sendMessage(chatId, adminOrderDetails);

            const confirmButton = {
                reply_markup: {
                    inline_keyboard: [[{ text: 'Confirm Order', callback_data: `confirm_buy_${order.id}_${chatId}` }]]
                }
            };
            bot.sendMessage(chatId, 'Please confirm the order:', confirmButton);
        } else {
            bot.sendMessage(chatId, 'Order not found. Let\'s create it manually. Please enter the Telegram ID of the user:');

            const handleTelegramId = async (userMsg) => {
                const telegramId = userMsg.text;

                bot.sendMessage(chatId, 'Enter the username of the user:');

                const handleUsername = async (userMsg) => {
                    const username = userMsg.text;

                    bot.sendMessage(chatId, 'Enter the amount:');

                    const handleAmount = async (userMsg) => {
                        const amount = parseFloat(userMsg.text);

                        bot.sendMessage(chatId, 'Enter the number of stars:');

                        const handleStars = async (userMsg) => {
                            const stars = parseInt(userMsg.text, 10);

                            bot.sendMessage(chatId, 'Enter the wallet address:');

                            const handleWalletAddress = async (userMsg) => {
                                const walletAddress = userMsg.text;

                                const newOrder = new BuyOrder({
                                    id: orderId,
                                    telegramId,
                                    username,
                                    amount,
                                    stars,
                                    walletAddress,
                                    status: 'pending',
                                    dateCreated: new Date(),
                                    adminMessages: []
                                });

                                await newOrder.save();

                                const userOrderDetails = `Your buy order has been recreated:\n\nID: ${orderId}\nUsername: ${username}\nAmount: ${amount}\nStars: ${stars}\nWallet: ${walletAddress}\nStatus: pending\nDate Created: ${new Date()}`;
                                bot.sendMessage(telegramId, userOrderDetails);

                                const adminOrderDetails = `Buy Order Recreated:\n\nID: ${orderId}\nUsername: ${username}\nAmount: ${amount}\nStars: ${stars}\nWallet: ${walletAddress}\nStatus: pending\nDate Created: ${new Date()}`;
                                bot.sendMessage(chatId, adminOrderDetails);

                                const confirmButton = {
                                    reply_markup: {
                                        inline_keyboard: [[{ text: 'Confirm Order', callback_data: `confirm_buy_${orderId}_${chatId}` }]]
                                    }
                                };
                                bot.sendMessage(chatId, 'Please confirm the order:', confirmButton);
                            };

                            bot.once('message', handleWalletAddress);
                        };

                        bot.once('message', handleStars);
                    };

                    bot.once('message', handleAmount);
                };

                bot.once('message', handleUsername);
            };

            bot.once('message', handleTelegramId);
        }
    } catch (error) {
        console.error('Error recreating buy order:', error);
        bot.sendMessage(chatId, 'An error occurred while processing your request.');
    }
});
                
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    try {
        if (data.startsWith('confirm_sell_')) {
            const [_, __, orderId, adminChatId] = data.split('_');
            const order = await SellOrder.findOne({ id: orderId });

            if (order) {
                order.status = 'confirmed';
                order.dateConfirmed = new Date();
                await order.save();

                const userOrderDetails = `Your sell order has been confirmed:\n\nID: ${order.id}\nUsername: ${order.username}\nStars: ${order.stars}\nWallet: ${order.walletAddress}\nStatus: confirmed\nDate Created: ${order.dateCreated}`;
                bot.sendMessage(order.telegramId, userOrderDetails);

                const adminOrderDetails = `Sell Order Confirmed:\n\nID: ${order.id}\nUsername: ${order.username}\nStars: ${order.stars}\nWallet: ${order.walletAddress}\nStatus: confirmed\nDate Created: ${order.dateCreated}`;
                bot.sendMessage(adminChatId, adminOrderDetails);

                const disabledButton = {
                    reply_markup: {
                        inline_keyboard: [[{ text: 'Confirmed', callback_data: 'confirmed', disabled: true }]]
                    }
                };
                bot.editMessageReplyMarkup(disabledButton, { chat_id: chatId, message_id: query.message.message_id });
            }
        } else if (data.startsWith('confirm_buy_')) {
            const [_, __, orderId, adminChatId] = data.split('_');
            const order = await BuyOrder.findOne({ id: orderId });

            if (order) {
                order.status = 'confirmed';
                order.dateConfirmed = new Date();
                await order.save();

                const userOrderDetails = `Your buy order has been confirmed:\n\nID: ${order.id}\nUsername: ${order.username}\nAmount: ${order.amount}\nStars: ${order.stars}\nWallet: ${order.walletAddress}\nStatus: confirmed\nDate Created: ${order.dateCreated}`;
                bot.sendMessage(order.telegramId, userOrderDetails);

                const adminOrderDetails = `Buy Order Confirmed:\n\nID: ${order.id}\nUsername: ${order.username}\nAmount: ${order.amount}\nStars: ${order.stars}\nWallet: ${order.walletAddress}\nStatus: confirmed\nDate Created: ${order.dateCreated}`;
                bot.sendMessage(adminChatId, adminOrderDetails);

                const disabledButton = {
                    reply_markup: {
                        inline_keyboard: [[{ text: 'Confirmed', callback_data: 'confirmed', disabled: true }]]
                    }
                };
                bot.editMessageReplyMarkup(disabledButton, { chat_id: chatId, message_id: query.message.message_id });
            }
        }
    } catch (error) {
        console.error('Error confirming order:', error);
        bot.sendMessage(chatId, 'An error occurred while confirming the order.');
    }
});  
            
   //second user detection for adding users incase the start command doesn't work or not reachable 
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const username = msg.from.username || 'user';

    try {
        const existingCache = await Cache.findOne({ id: chatId });
        if (!existingCache) {
            await Cache.create({ id: chatId, username: username });
        }
    } catch (error) {
        console.error('Error caching user interaction:', error);
    }
});

bot.onText(/\/detect_users/, async (msg) => {
    const chatId = msg.chat.id;

    try {
        const cachedUsers = await Cache.find({});
        let totalDetected = cachedUsers.length;
        let totalAdded = 0;
        let totalFailed = 0;

        for (const user of cachedUsers) {
            try {
                const existingUser = await User.findOne({ id: user.id });
                if (!existingUser) {
                    await User.create({ id: user.id, username: user.username });
                    totalAdded++;
                }
            } catch (error) {
                console.error(`Failed to add user ${user.id}:`, error);
                totalFailed++;
            }
        }

        // Clear the cache after processing
        await Cache.deleteMany({});

        const reportMessage = `User Detection Report:\n\nTotal Detected: ${totalDetected}\nTotal Added: ${totalAdded}\nTotal Failed: ${totalFailed}`;
        bot.sendMessage(chatId, reportMessage);
    } catch (error) {
        console.error('Error detecting users:', error);
        bot.sendMessage(chatId, 'An error occurred while detecting users.');
    }
});


//reverse orders
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

    const orderAgeInDays = (new Date() - order.dateCreated) / (1000 * 60 * 60 * 24);
    if (orderAgeInDays > 15) {
        return bot.sendMessage(chatId, "❌ This order cannot be reversed because it is older than 15 days.");
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
                const botBalance = await BotBalance.findOne({ id: "bot" });
                if (!botBalance) {
                    const newBotBalance = new BotBalance({ id: "bot", balance: 1000 });
                    await newBotBalance.save();
                    return bot.answerCallbackQuery(query.id, { text: "Insufficient bot balance to process the reversal." });
                }
                if (botBalance.balance < reversalRequest.stars) {
                    return bot.answerCallbackQuery(query.id, { text: "Insufficient bot balance to process the reversal." });
                }

                await transferStars("bot", reversalRequest.telegramId, reversalRequest.stars);
                botBalance.balance -= reversalRequest.stars;
                await botBalance.save();
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

async function transferStars(fromUserId, toUserId, stars) {
    try {
        const fromUser = await User.findOne({ id: fromUserId });
        if (!fromUser || fromUser.stars < stars) {
            throw new Error('Insufficient stars to transfer.');
        }
        fromUser.stars -= stars;
        await fromUser.save();

        const toUser = await User.findOne({ id: toUserId });
        if (!toUser) {
            throw new Error('Receiver not found.');
        }
        toUser.stars += stars;
        await toUser.save();

        console.log(`Transferred ${stars} stars from ${fromUserId} to ${toUserId}.`);
    } catch (error) {
        console.error('Error transferring stars:', error);
        throw error;
    }
}


// Add this new handler for claim generation
bot.onText(/\/generate_claim/, async (msg) => {
  const claimCode = "CLAIM_" + Math.random().toString(36).slice(2, 6).toUpperCase();
  
  await Claim.create({
    claimCode,
    adminId: msg.chat.id,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours
  });

  bot.sendMessage(
    msg.chat.id,
    `🔗 Share this claim link (expires in 24 hours):\n\n` +
    `https://t.me/TgStarStore_bot?start=${claimCode}`,
    { disable_web_page_preview: true }
  );
});
// Wallet Submission Handler (No Validation)
bot.on('message', async (msg) => {
    // Skip if message is a command or doesn't have text
    if (!msg.text || msg.text.startsWith('/')) return;
    
    // Find active claim for this user
    const claim = await Claim.findOne({
        userId: msg.chat.id,
        wallet: { $exists: false },
        expiresAt: { $gt: new Date() }
    });
    
    // Exit if no pending claim
    if (!claim) return;
    
    try {
        // Process any text input as wallet address
        const submittedWallet = msg.text.trim();
        
        // Update claim record
        await Claim.updateOne(
            { _id: claim._id },
            { 
                $set: { 
                    wallet: submittedWallet,
                    username: msg.from.username || 'N/A',
                    claimedAt: new Date() 
                } 
            }
        );

        // User confirmation
        await bot.sendMessage(
            msg.chat.id,
            `✅ Submission received!\n\n` +
            `Your entered address: \`${submittedWallet}\`\n\n` +
            `Thank you for participating.`,
            { parse_mode: "Markdown" }
        );

        // Notify all admins
        const adminMessage = `📥 New Wallet Submission\n\n` +
            `• User: @${msg.from.username || 'N/A'} (ID: ${msg.chat.id})\n` +
            `• Submitted: \`${submittedWallet}\`\n` +
            `• Claim Code: ${claim.claimCode}\n` +
            `• Generated by: ${claim.adminId}`;

        // Send to all admins from env
        await Promise.all(
            process.env.ADMIN_TELEGRAM_IDS.split(',').map(adminId => {
                return bot.sendMessage(
                    adminId.trim(),
                    adminMessage,
                    { parse_mode: "Markdown" }
                );
            })
        );

    } catch (error) {
        console.error('Submission Error:', error);
        bot.sendMessage(msg.chat.id, "⚠️ An error occurred. Please try again.");
    }
});

//survey form submission 
app.post('/api/survey', async (req, res) => {
    try {
        const surveyData = req.body;
        
        let message = `📊 *New Survey Submission*\n\n`;
        message += `*Usage Frequency*: ${surveyData.usageFrequency}\n`;
        
        if (surveyData.favoriteFeatures) {
            const features = Array.isArray(surveyData.favoriteFeatures) 
                ? surveyData.favoriteFeatures.join(', ') 
                : surveyData.favoriteFeatures;
            message += `*Favorite Features*: ${features}\n`;
        }
        
        message += `*Desired Features*: ${surveyData.desiredFeatures}\n`;
        message += `*Overall Rating*: ${surveyData.overallRating}/5\n`;
        
        if (surveyData.improvementFeedback) {
            message += `*Improvement Feedback*: ${surveyData.improvementFeedback}\n`;
        }
        
        message += `*Technical Issues*: ${surveyData.technicalIssues || 'No'}\n`;
        
        if (surveyData.technicalIssues === 'yes' && surveyData.technicalIssuesDetails) {
            message += `*Issue Details*: ${surveyData.technicalIssuesDetails}\n`;
        }
        
        message += `\n📅 Submitted: ${new Date().toLocaleString()}`;
        
        const sendPromises = adminIds.map(chatId => {
            return bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        });
        
        await Promise.all(sendPromises);
        
        res.status(200).json({ success: true });
    } catch (error) {
        console.error('Error processing survey:', error);
        res.status(500).json({ success: false, error: 'Failed to process survey' });
    }
});

//get total users from db
bot.onText(/\/users/, async (msg) => {
    const chatId = msg.chat.id;
    if (!adminIds.includes(chatId.toString())) {
        bot.sendMessage(chatId, '❌ Unauthorized: Only admins can use this command.');
        return;
    }

    try {
        const userCount = await User.countDocuments({});
        bot.sendMessage(chatId, `📊 Total users in the database: ${userCount}`);
    } catch (err) {
        console.error('Error fetching user count:', err);
        bot.sendMessage(chatId, '❌ Failed to fetch user count.');
    }
});

const fetch = require('node-fetch');

setInterval(() => {
  fetch('https://tg-star-store-production.up.railway.app')
    .then(response => console.log('Ping successful'))
    .catch(err => console.error('Ping failed:', err));
}, 4 * 60 * 1000);

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Webhook set to: ${WEBHOOK_URL}`);
});
