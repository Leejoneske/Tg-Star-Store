require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const cors = require('cors');
const axios = require('axios');

const app = express();
const bot = new TelegramBot(process.env.BOT_TOKEN, { webHook: true });

const SERVER_URL = (process.env.RAILWAY_STATIC_URL || 
                   process.env.RAILWAY_PUBLIC_DOMAIN || 
                   'tg-star-store-production.up.railway.app');
const WEBHOOK_PATH = '/telegram-webhook';
const WEBHOOK_URL = `https://${SERVER_URL}${WEBHOOK_PATH}`;
const verifyTelegramAuth = require('./middleware/telegramAuth');
const reversalRequests = new Map();

// Middleware
app.use(cors());
app.use(express.json());
app.use(bodyParser.json());
app.use(express.static('public'));
app.use(verifyTelegramAuth(process.env.BOT_TOKEN));

// Webhook setup
bot.setWebHook(WEBHOOK_URL)
  .then(() => console.log(`✅ Webhook set successfully at ${WEBHOOK_URL}`))
  .catch(err => {
    console.error('❌ Webhook setup failed:', err.message);
    process.exit(1);
  });

// MongoDB connection
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected successfully'))
  .catch(err => {
    console.error('❌ MongoDB connection error:', err.message);
    process.exit(1);
  });

// Webhook handler
app.post(WEBHOOK_PATH, (req, res) => {
  if (process.env.WEBHOOK_SECRET && 
      req.headers['x-telegram-bot-api-secret-token'] !== process.env.WEBHOOK_SECRET) {
    return res.sendStatus(403);
  }
  bot.processUpdate(req.body);
  res.sendStatus(200);
});



// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

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
    id: {
        type: String,
        required: true,
        unique: true
    },
    telegramId: {
        type: String,
        required: true
    },
    username: String,
    stars: {
        type: Number,
        required: true
    },
    walletAddress: String,
    status: {
        type: String,
        enum: ['pending', 'processing', 'completed', 'declined', 'reversed', 'refunded'],
        default: 'pending'
    },
    telegram_payment_charge_id: {
        type: String,
        required: function() {
            
            return this.dateCreated > new Date('2025-05-23'); 
        },
        default: null
    },
    reversible: {
        type: Boolean,
        default: true
    },
    reversalData: {
        requested: Boolean,
        reason: String,
        status: {
            type: String,
            enum: ['none', 'requested', 'approved', 'rejected', 'processed'],
            default: 'none'
        },
        adminId: String,
        processedAt: Date
    },
    refundData: {
        requested: Boolean,
        reason: String,
        status: {
            type: String,
            enum: ['none', 'requested', 'approved', 'rejected', 'processed'],
            default: 'none'
        },
        adminId: String,
        processedAt: Date,
        chargeId: String
    },
    adminMessages: [{
        adminId: String,
        messageId: Number,
        originalText: String,
        messageType: {
            type: String,
            enum: ['order', 'refund', 'reversal']
        }
    }],
    dateCreated: {
        type: Date,
        default: Date.now
    },
    dateCompleted: Date,
    dateReversed: Date,
    dateRefunded: Date
});

const userSchema = new mongoose.Schema({
    id: String,
    username: String
});

const bannedUserSchema = new mongoose.Schema({
    users: Array
});


const notificationSchema = new mongoose.Schema({
    message: String,
    timestamp: String
});


const cacheSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    username: { type: String, required: true },
    date: { type: Date, default: Date.now }
});


const referralSchema = new mongoose.Schema({
    referrerUserId: { type: String, required: true },
    referredUserId: { type: String, required: true },
    status: { type: String, enum: ['pending', 'active', 'completed'], default: 'pending' },
    withdrawn: { type: Boolean, default: false },
    dateReferred: { type: Date, default: Date.now }
});

const referralWithdrawalSchema = new mongoose.Schema({
    withdrawalId: {  
        type: String,
        required: true,
        unique: true,
        default: () => generateOrderId() 
    },
    userId: String,
    username: String,
    amount: Number,
    walletAddress: String,
    referralIds: [{ 
        type: String, 
        ref: 'Referral' 
    }],
    status: { 
        type: String, 
        enum: ['pending', 'completed', 'declined'], 
        default: 'pending' 
    },
    createdAt: { 
        type: Date, 
        default: Date.now 
    }
});

const referralTrackerSchema = new mongoose.Schema({
    referral: { type: mongoose.Schema.Types.ObjectId, ref: 'Referral' },
    referrerUserId: { type: String, required: true },
    referredUserId: { type: String, required: true, unique: true },
    referredUsername: String,
    totalBoughtStars: { type: Number, default: 0 },
    totalSoldStars: { type: Number, default: 0 },
    premiumActivated: { type: Boolean, default: false },
    status: { type: String, enum: ['pending', 'active'], default: 'pending' },
    dateReferred: { type: Date, default: Date.now },
    dateActivated: Date
});


// Add to your schemas section
const feedbackSchema = new mongoose.Schema({
    orderId: { type: String, required: true },
    telegramId: { type: String, required: true },
    username: String,
    satisfaction: { type: Number, min: 1, max: 5 }, 
    reasons: String, // Why they rated this way
    suggestions: String, // What could be improved
    additionalInfo: String, // Optional free-form feedback
    dateSubmitted: { type: Date, default: Date.now }
});

const reversalSchema = new mongoose.Schema({
    orderId: { type: String, required: true },
    telegramId: { type: String, required: true },
    username: String,
    stars: { type: Number, required: true },
    reason: { type: String, required: true },
    status: { type: String, enum: ['pending', 'approved', 'rejected', 'processed'], default: 'pending' },
    adminId: String,
    adminUsername: String,
    processedAt: Date
});

const UserWarningSchema = new mongoose.Schema({
    userId: {
        type: String,
        required: true,
        unique: true
    },
    warnings: [{
        reason: {
            type: String,
            required: true
        },
        issuedBy: {
            type: String,
            required: true
        },
        timestamp: {
            type: Date,
            default: Date.now
        }
    }]
}, {
    timestamps: true
});

const UserWarning = mongoose.model('UserWarning', UserWarningSchema);
const Reversal = mongoose.model('Reversal', reversalSchema);
const Feedback = mongoose.model('Feedback', feedbackSchema);
const ReferralTracker = mongoose.model('ReferralTracker', referralTrackerSchema);
const ReferralWithdrawal = mongoose.model('ReferralWithdrawal', referralWithdrawalSchema);
const Cache = mongoose.model('Cache', cacheSchema);
const BuyOrder = mongoose.model('BuyOrder', buyOrderSchema);
const SellOrder = mongoose.model('SellOrder', sellOrderSchema);
const User = mongoose.model('User', userSchema);
const Notification = mongoose.model('Notification', notificationSchema);
const Referral = mongoose.model('Referral', referralSchema);
const BannedUser = mongoose.model('BannedUser', bannedUserSchema);


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
                { text: '✅ Complete', callback_data: `complete_buy_${order.id}` },
                { text: '❌ Decline', callback_data: `decline_buy_${order.id}` }
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
            telegram_payment_charge_id: "temp_" + Date.now(),
            reversible: true,
            dateCreated: new Date(),
            adminMessages: [],
        });

        const paymentLink = await createTelegramInvoice(telegramId, order.id, stars, `Purchase of ${stars} Telegram Stars`);
        if (!paymentLink) {
            return res.status(500).json({ error: "Failed to generate payment link" });
        }

        await order.save();

        const userMessage = `🚀 Sell order initialized!\n\nOrder ID: ${order.id}\nStars: ${order.stars}\nStatus: Pending (Waiting for payment)\n\nPay here: ${paymentLink}`;
        await bot.sendMessage(telegramId, userMessage);

        res.json({ success: true, order, paymentLink });
    } catch (err) {
        console.error("Sell order creation error:", err);
        res.status(500).json({ error: "Failed to create sell order" });
    }
});

bot.on('pre_checkout_query', async (query) => {
    const orderId = query.invoice_payload;
    const order = await SellOrder.findOne({ id: orderId }) || await BuyOrder.findOne({ id: orderId });
    await bot.answerPreCheckoutQuery(query.id, !!order);
});

bot.on("successful_payment", async (msg) => {
    const orderId = msg.successful_payment.invoice_payload;
    const order = await SellOrder.findOne({ id: orderId });

    if (!order) {
        return await bot.sendMessage(msg.chat.id, "❌ Payment was successful, but the order was not found. Please contact support.");
    }

    order.telegram_payment_charge_id = msg.successful_payment.telegram_payment_charge_id;
    order.status = "processing"; 
    order.datePaid = new Date();
    await order.save();

    await bot.sendMessage(
        order.telegramId,
        `✅ Payment successful!\n\nOrder ID: ${order.id}\nStars: ${order.stars}\nStatus: Processing (Under admin review)`
    );

    const adminMessage = `💰 New Payment Received!\n\n` +
        `Order ID: ${order.id}\n` +
        `User: @${order.username} (ID: ${order.telegramId})\n` + 
        `Stars: ${order.stars}\n` +
        `Wallet: ${order.walletAddress}`;

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
                { reply_markup: adminKeyboard }
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

bot.on('callback_query', async (query) => {
    try {
        const data = query.data;
        const adminUsername = query.from.username || `admin_${query.from.id}`;

        let order, actionType, orderType;

        if (data.startsWith('complete_sell_')) {
            actionType = 'complete';
            orderType = 'sell';
            order = await SellOrder.findOne({ id: data.split('_')[2] });

            if (!order) {
                await bot.answerCallbackQuery(query.id, { text: "Sell order not found" });
                return;
            }

            if (order.status !== 'processing') {
                await bot.answerCallbackQuery(query.id, { 
                    text: `Order is ${order.status} - cannot complete` 
                });
                return;
            }

            if (!order.telegram_payment_charge_id && order.dateCreated > new Date('2025-05-23')) {
                await bot.answerCallbackQuery(query.id, { 
                    text: "Cannot complete - missing payment reference" 
                });
                return;
            }

            order.status = 'completed';
            order.dateCompleted = new Date();
            await order.save();
            await trackStars(order.telegramId, order.stars, 'sell');
        } 
        else if (data.startsWith('decline_sell_')) {
            actionType = 'decline';
            orderType = 'sell';
            order = await SellOrder.findOne({ id: data.split('_')[2] });

            if (!order) {
                await bot.answerCallbackQuery(query.id, { text: "Sell order not found" });
                return;
            }

            order.status = 'declined';
            order.dateDeclined = new Date();
            await order.save();
        }
        else if (data.startsWith('complete_buy_')) {
            actionType = 'complete';
            orderType = 'buy';
            order = await BuyOrder.findOne({ id: data.split('_')[2] });

            if (!order) {
                await bot.answerCallbackQuery(query.id, { text: "Buy order not found" });
                return;
            }

            if (order.status !== 'pending') {
                await bot.answerCallbackQuery(query.id, { 
                    text: `Order is ${order.status} - cannot complete` 
                });
                return;
            }

            order.status = 'completed';
            order.dateCompleted = new Date();
            await order.save();
            await trackStars(order.telegramId, order.stars, 'buy');
            if (order.isPremium) {
                await trackPremiumActivation(order.telegramId);
            }
        }
        else if (data.startsWith('decline_buy_')) {
            actionType = 'decline';
            orderType = 'buy';
            order = await BuyOrder.findOne({ id: data.split('_')[2] });

            if (!order) {
                await bot.answerCallbackQuery(query.id, { text: "Buy order not found" });
                return;
            }

            order.status = 'declined';
            order.dateDeclined = new Date();
            await order.save();
        }
        else {
            return await bot.answerCallbackQuery(query.id);
        }

        const statusText = order.status === 'completed' ? '✅ Completed' : '❌ Declined';
        const processedBy = `Processed by: @${adminUsername}`;
        const completionNote = orderType === 'sell' && order.status === 'completed' ? '\n\nStars have been transferred to the buyer.' : '';

        const updatePromises = order.adminMessages.map(async (adminMsg) => {
            try {
                const updatedText = `${adminMsg.originalText}\n\n${statusText}\n${processedBy}${completionNote}`;
                
                if (updatedText.length > 4000) {
                    console.warn(`Message too long for admin ${adminMsg.adminId}`);
                    return;
                }
                
                await bot.editMessageText(updatedText, {
                    chat_id: adminMsg.adminId,
                    message_id: adminMsg.messageId,
                    reply_markup: {
                        inline_keyboard: [[
                            { 
                                text: statusText, 
                                callback_data: `processed_${order.id}_${Date.now()}`
                            }
                        ]]
                    }
                });
            } catch (err) {
                console.error(`Failed to update admin ${adminMsg.adminId}:`, err);
            }
        });

        await Promise.allSettled(updatePromises);

        const userMessage = order.status === 'completed' 
            ? `✅ Your ${orderType} order #${order.id} has been confirmed!${orderType === 'sell' ? '\n\nPayment has been sent to your wallet.' : '\n\nThank you for your purchase!'}`
            : `❌ Your ${orderType} order #${order.id} has been declined.\n\nPlease contact support if you believe this was a mistake.`;

        await bot.sendMessage(order.telegramId, userMessage);

        await bot.answerCallbackQuery(query.id, { 
            text: `${orderType} order ${order.status}` 
        });

    } catch (err) {
        console.error('Order processing error:', err);
        const errorMsg = err.response?.description || err.message || "Processing failed";
        await bot.answerCallbackQuery(query.id, { 
            text: `Error: ${errorMsg.slice(0, 50)}` 
        });
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
        return response.data.result;
    } catch (error) {
        console.error('Error creating invoice:', error);
        throw error;
    }
}


// ===== REVERSAL/PAYMENT SUPPORT SYSTEM =====
bot.onText(/^\/(reverse|paysupport)(?:\s+(.+))?/i, async (msg, match) => {
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
        return bot.sendMessage(chatId, 
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
        
        reversalRequests.set(chatId, { 
            step: 'waiting_order_id', 
            timestamp: Date.now() 
        });
        return bot.sendMessage(chatId, welcomeMsg);
    }
    
    const order = await SellOrder.findOne({ id: orderId, telegramId: userId });
    
    if (!order) return bot.sendMessage(chatId, "❌ Order not found or doesn't belong to you");
    if (order.status !== 'processing') return bot.sendMessage(chatId, `❌ Order is ${order.status} - cannot be reversed`);
    
    reversalRequests.set(chatId, { 
        step: 'waiting_reason',
        orderId, 
        timestamp: Date.now() 
    });
    bot.sendMessage(chatId, 
        `📋 Order Found: ${orderId}\n` +
        `Stars: ${order.stars}\n\n` +
        `Please provide a detailed explanation (minimum 10 words) for why you need to reverse this order:`
    );
});

bot.onText(/^\/adminrefund (.+)/i, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!adminIds.includes(chatId.toString())) return bot.sendMessage(chatId, "❌ Access denied");
    
    const txId = match[1].trim();
    const order = await SellOrder.findOne({ telegram_payment_charge_id: txId });
    
    if (!order) return bot.sendMessage(chatId, "❌ Order not found with this TX ID");
    if (order.status === 'refunded') return bot.sendMessage(chatId, "❌ Order already refunded");
    
    try {
        const result = await processRefund(order.id);
        
        if (result.success) {
            const statusMessage = result.alreadyRefunded 
                ? `✅ Order ${order.id} was already refunded\nTX ID: ${result.chargeId}`
                : `✅ Admin refund processed for order ${order.id}\nTX ID: ${result.chargeId}`;
            
            await bot.sendMessage(chatId, statusMessage);
            
            try {
                await bot.sendMessage(
                    parseInt(order.telegramId),
                    `💸 Refund Processed by Admin\nOrder: ${order.id}\nTX ID: ${result.chargeId}`
                );
            } catch (userError) {
                await bot.sendMessage(chatId, `⚠️ Refund processed but user notification failed`);
            }
        }
    } catch (error) {
        await bot.sendMessage(chatId, `❌ Admin refund failed for ${order.id}\nError: ${error.message}`);
    }
});

bot.onText(/^\/refundtx (.+) (.+)/i, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!adminIds.includes(chatId.toString())) return bot.sendMessage(chatId, "❌ Access denied");
    
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
                return bot.sendMessage(chatId, `✅ TX ${txId} was already refunded`);
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
            await bot.sendMessage(
                parseInt(userId),
                `💸 Refund Processed by Admin\nTX ID: ${txId}`
            );
        } catch (userError) {}

        await bot.sendMessage(chatId, `✅ Direct refund processed for TX: ${txId}\nUser: ${userId}`);

    } catch (error) {
        await bot.sendMessage(chatId, `❌ Direct refund failed for TX ${txId}\nError: ${error.message}`);
    }
});

bot.onText(/^\/getpayment (.+)/i, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!adminIds.includes(chatId.toString())) return bot.sendMessage(chatId, "❌ Access denied");
    
    const txId = match[1].trim();
    
    try {
        const { data } = await axios.post(
            `https://api.telegram.org/bot${process.env.BOT_TOKEN}/getStarTransactions`,
            { offset: 0, limit: 100 },
            { 
                timeout: 15000,
                headers: {
                    'Content-Type': 'application/json'
                }
            }
        );

        if (!data.ok) {
            throw new Error(data.description || "Failed to get transactions");
        }

        const transaction = data.result.transactions.find(t => 
            t.id === txId || (t.source && t.source.charge && t.source.charge.id === txId)
        );

        if (!transaction) {
            return bot.sendMessage(chatId, `❌ Transaction not found: ${txId}`);
        }

        const txInfo = `💳 Transaction Details\n` +
            `TX ID: ${transaction.id}\n` +
            `Amount: ${transaction.amount} stars\n` +
            `Date: ${new Date(transaction.date * 1000).toISOString()}\n` +
            `User ID: ${transaction.source ? transaction.source.user?.id || 'N/A' : 'N/A'}\n` +
            `Type: ${transaction.source ? transaction.source.type : 'N/A'}`;

        await bot.sendMessage(chatId, txInfo);

        if (transaction.source && transaction.source.user && transaction.source.user.id) {
            await bot.sendMessage(chatId, 
                `To refund this transaction, use:\n` +
                `/refundtx ${txId} ${transaction.source.user.id}`
            );
        }

    } catch (error) {
        await bot.sendMessage(chatId, `❌ Failed to get transaction details\nError: ${error.message}`);
    }
});

bot.onText(/^\/findorder (.+)/i, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!adminIds.includes(chatId.toString())) return bot.sendMessage(chatId, "❌ Access denied");
    
    const txId = match[1].trim();
    const order = await SellOrder.findOne({ telegram_payment_charge_id: txId });
    
    if (!order) return bot.sendMessage(chatId, "❌ Order not found with this TX ID");
    
    const orderInfo = `📋 Order Details\n` +
        `Order ID: ${order.id}\n` +
        `User ID: ${order.telegramId}\n` +
        `Stars: ${order.stars}\n` +
        `Status: ${order.status}\n` +
        `TX ID: ${order.telegram_payment_charge_id}\n` +
        `Created: ${order.dateCreated ? order.dateCreated.toISOString().split('T')[0] : 'N/A'}`;
    
    bot.sendMessage(chatId, orderInfo);
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = chatId.toString();
    const request = reversalRequests.get(chatId);
    if (!request || !msg.text || msg.text.startsWith('/')) return;
    
    if (Date.now() - request.timestamp > 300000) {
        reversalRequests.delete(chatId);
        return bot.sendMessage(chatId, "⌛ Session expired. Please start over with /reverse or /paysupport");
    }

    if (request.step === 'waiting_order_id') {
        const orderId = msg.text.trim();
        const order = await SellOrder.findOne({ id: orderId, telegramId: userId });
        
        if (!order) {
            return bot.sendMessage(chatId, "❌ Order not found or doesn't belong to you. Please enter a valid Order ID:");
        }
        if (order.status !== 'processing') {
            return bot.sendMessage(chatId, `❌ Order ${orderId} is ${order.status} - cannot be reversed. Please enter a different Order ID:`);
        }
        
        request.step = 'waiting_reason';
        request.orderId = orderId;
        request.timestamp = Date.now();
        reversalRequests.set(chatId, request);
        
        return bot.sendMessage(chatId, 
            `📋 Order Found: ${orderId}\n` +
            `Stars: ${order.stars}\n\n` +
            `Please provide a detailed explanation (minimum 10 words) for why you need to reverse this order:`
        );
    }

    if (request.step === 'waiting_reason') {
        const reason = msg.text.trim();
        const wordCount = reason.split(/\s+/).filter(word => word.length > 0).length;
        
        if (wordCount < 10) {
            return bot.sendMessage(chatId, 
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
        
        for (const adminId of adminIds) {
            try {
                const message = await bot.sendMessage(parseInt(adminId), adminMsg, {
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
                try {
                    await bot.sendMessage(parseInt(adminId), adminMsg, {
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    { text: "✅ Approve", callback_data: `req_approve_${request.orderId}` },
                                    { text: "❌ Reject", callback_data: `req_reject_${request.orderId}` }
                                ]
                            ]
                        }
                    });
                    requestDoc.adminMessages.push({ 
                        adminId: adminId, 
                        messageId: message.message_id,
                        messageType: 'refund'
                    });
                } catch (fallbackErr) {
                    console.error(`Fallback send to admin ${adminId} also failed:`, fallbackErr.message);
                }
            }
        }
        await requestDoc.save();
        bot.sendMessage(chatId, `📨 Reversal request submitted for order ${request.orderId}\nYou will be notified once reviewed.`);
        reversalRequests.delete(chatId);
    }
});

async function processRefund(orderId) {
    const session = await mongoose.startSession();
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

bot.on('callback_query', async (query) => {
    try {
        const [_, action, orderId] = query.data.split('_');
        if (!adminIds.includes(query.from.id.toString())) return;

        const request = await Reversal.findOne({ orderId });
        if (!request || request.status !== 'pending') return;

        if (action === 'approve') {
            try {
                const result = await processRefund(orderId);
                
                request.status = 'completed';
                request.processedAt = new Date();
                await request.save();

                const statusMessage = result.alreadyRefunded 
                    ? `✅ Order ${orderId} was already refunded\nCharge ID: ${result.chargeId}`
                    : `✅ Refund processed successfully for ${orderId}\nCharge ID: ${result.chargeId}`;

                await bot.sendMessage(query.from.id, statusMessage);
                
                try {
                    const userMessage = result.alreadyRefunded
                        ? `💸 Your refund for order ${orderId} was already processed\nTX ID: ${result.chargeId}`
                        : `💸 Refund Processed\nOrder: ${orderId}\nTX ID: ${result.chargeId}`;
                    
                    await bot.sendMessage(parseInt(request.telegramId), userMessage);
                } catch (userError) {
                    console.error('Failed to notify user:', userError.message);
                    await bot.sendMessage(query.from.id, `⚠️ Refund processed but user notification failed`);
                }

            } catch (refundError) {
                request.status = 'declined';
                request.errorMessage = refundError.message;
                await request.save();
                
                await bot.sendMessage(query.from.id, `❌ Refund failed for ${orderId}\nError: ${refundError.message}`);
            }
        } else if (action === 'reject') {
            request.status = 'declined';
            request.processedAt = new Date();
            await request.save();
            
            await bot.sendMessage(query.from.id, `❌ Refund request rejected for ${orderId}`);
            
            try {
                await bot.sendMessage(parseInt(request.telegramId), `❌ Your refund request for order ${orderId} has been rejected.`);
            } catch (userError) {
                console.error('Failed to notify user of rejection:', userError.message);
            }
        }

        await updateAdminMessages(request, action === 'approve' ? "✅ REFUNDED" : "❌ REJECTED");
        await bot.answerCallbackQuery(query.id);

    } catch (error) {
        console.error('Callback processing error:', error);
        await bot.answerCallbackQuery(query.id, { text: "Processing error occurred" });
    }
});

async function updateAdminMessages(request, statusText) {
    if (!request.adminMessages || request.adminMessages.length === 0) return;
    
    for (const msg of request.adminMessages) {
        try {
            await bot.editMessageReplyMarkup(
                { inline_keyboard: [[{ text: statusText, callback_data: 'processed_done' }]] },
                { chat_id: parseInt(msg.adminId), message_id: msg.messageId }
            );
        } catch (err) {
            console.error(`Failed to update admin message for ${msg.adminId}:`, err.message);
        }
    }
}

setInterval(() => {
    const now = Date.now();
    const expiredSessions = [];
    
    reversalRequests.forEach((value, chatId) => {
        if (now - value.timestamp > 300000) {
            expiredSessions.push(chatId);
        }
    });
    
    expiredSessions.forEach(chatId => {
        bot.sendMessage(chatId, "⌛ Session expired").catch(() => {});
        reversalRequests.delete(chatId);
    });
}, 60000);



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

//for referral page 
app.get('/api/referral-stats/:userId', async (req, res) => {
    try {
        const referrals = await Referral.find({ referrerUserId: req.params.userId });
        const referredUserIds = referrals.map(r => r.referredUserId);
        const users = await User.find({ id: { $in: referredUserIds } });
        
        const userMap = {};
        users.forEach(user => userMap[user.id] = user.username);

        const totalReferrals = referrals.length;
        
        // Get completed/active AND non-withdrawn referrals
        const availableReferrals = await Referral.find({
            referrerUserId: req.params.userId,
            status: { $in: ['completed', 'active'] },
            withdrawn: { $ne: true } // Changed from false to $ne: true for better handling
        }).countDocuments();

        // Get all completed/active (regardless of withdrawal status)
        const completedReferrals = referrals.filter(r => 
            ['completed', 'active'].includes(r.status)
        ).length;

        res.json({
            success: true,
            referrals: referrals.map(ref => ({
                userId: ref.referredUserId,
                name: userMap[ref.referredUserId] || `User ${ref.referredUserId.substring(0, 6)}`,
                status: ref.status.toLowerCase(),
                date: ref.dateReferred || ref.dateCreated || new Date(0),
                amount: 0.5
            })),
            stats: {
                availableBalance: availableReferrals * 0.5,
                totalEarned: completedReferrals * 0.5,
                referralsCount: totalReferrals,
                pendingAmount: (totalReferrals - completedReferrals) * 0.5
            },
            referralLink: `https://t.me/TgStarStore_bot?start=ref_${req.params.userId}`
        });
        
    } catch (error) {
        console.error('Referral stats error:', error);
        res.status(500).json({ 
            success: false,
            error: 'Failed to load referral data' 
        });
    }
});
//get history for referrals withdraw for referral page

app.get('/api/withdrawal-history/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const withdrawals = await ReferralWithdrawal.find({ userId })
            .sort({ createdAt: -1 })
            .limit(50);

        res.json({ success: true, withdrawals });
    } catch (error) {
        console.error('Withdrawal history error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});


// Withdrawal endpoint
app.post('/api/referral-withdrawals', async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const { userId, amount, walletAddress } = req.body;
        const amountNum = parseFloat(amount);

        if (!userId || !amount || !walletAddress) {
            throw new Error('Missing required fields');
        }

        const user = await User.findOne({ id: userId }).session(session) || {};
        const availableReferrals = await Referral.find({
            referrerUserId: userId,
            status: { $in: ['completed', 'active'] },
            withdrawn: { $ne: true }
        }).session(session);

        const availableBalance = availableReferrals.length * 0.5;

        if (amountNum < 0.5) throw new Error('Minimum withdrawal is 0.5 USDT');
        if (amountNum > availableBalance) throw new Error(`Available: ${availableBalance.toFixed(2)} USDT`);

        const referralsNeeded = Math.ceil(amountNum / 0.5);
        const referralsToMark = availableReferrals.slice(0, referralsNeeded);

        const username = user.username || `@user`;

        const withdrawal = new ReferralWithdrawal({
            userId,
            username: username,
            amount: amountNum,
            walletAddress: walletAddress.trim(),
            referralIds: referralsToMark.map(r => r._id),
            status: 'pending',
            adminMessages: [],
            createdAt: new Date()
        });

        await withdrawal.save({ session });

        await Referral.updateMany(
            { _id: { $in: referralsToMark.map(r => r._id) } },
            { $set: { withdrawn: true } },
            { session }
        );

        try {
            await bot.sendSticker(userId, 'CAACAgIAAxkBAAEOfU1oJPNMEdvuCLmOLYdxV9Nb5TKe-QACfz0AAi3JKUp2tyZPFVNcFzYE');
        } catch (stickerError) {
            console.error('Failed to send sticker:', stickerError);
        }

        const userMessage = `Withdrawal Request Submitted\n\n` +
                          `Amount: ${amountNum} USDT\n` +
                          `Wallet: ${walletAddress}\n` +
                          `ID: WD${withdrawal._id.toString().slice(-8).toUpperCase()}\n\n` +
                          `Status: Pending approval`;

        await bot.sendMessage(userId, userMessage);

        const adminMessage = `New Withdrawal Request\n\n` +
                           `User: ${username}\n` +
                           `ID: ${userId}\n` +
                           `Amount: ${amountNum} USDT\n` +
                           `Wallet: ${walletAddress}\n` +
                           `Referrals: ${referralsNeeded}\n` +
                           `WDID: WD${withdrawal._id.toString().slice(-8).toUpperCase()}`;

        const adminKeyboard = {
            inline_keyboard: [
                [
                    { text: "✅ Complete", callback_data: `complete_withdrawal_${withdrawal._id}` },
                    { text: "❌ Decline", callback_data: `decline_withdrawal_${withdrawal._id}` }
                ]
            ]
        };

        withdrawal.adminMessages = await Promise.all(adminIds.map(async adminId => {
            try {
                const message = await bot.sendMessage(
                    adminId,
                    adminMessage,
                    { reply_markup: adminKeyboard }
                );
                return {
                    adminId,
                    messageId: message.message_id,
                    originalText: adminMessage
                };
            } catch (err) {
                console.error(`Failed to notify admin ${adminId}:`, err);
                return null;
            }
        })).then(results => results.filter(Boolean));

        await withdrawal.save({ session });
        await session.commitTransaction();
        return res.json({ success: true, withdrawalId: withdrawal._id });

    } catch (error) {
        await session.abortTransaction();
        console.error('Withdrawal error:', error);
        return res.status(400).json({ success: false, error: error.message });
    } finally {
        session.endSession();
    }
});

// ===== WITHDRAWAL PROCESSING =====
bot.on('callback_query', async (query) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const { data, from } = query;
        
        // Admin authorization check
        if (!adminIds.includes(from.id.toString())) {
            await bot.answerCallbackQuery(query.id, { text: "⛔ Unauthorized action" });
            return;
        }

        // Parse action and withdrawal ID
        const action = data.startsWith('complete_withdrawal_') ? 'complete' : 'decline';
        const withdrawalId = data.split('_')[2]; // Custom string ID

        await bot.answerCallbackQuery(query.id, { text: `⏳ Processing ${action}...` });

        // Find and update withdrawal using string ID
        const withdrawal = await ReferralWithdrawal.findOneAndUpdate(
            { withdrawalId: withdrawalId, status: 'pending' },
            { 
                $set: { 
                    status: action === 'complete' ? 'completed' : 'declined',
                    processedBy: from.id,
                    processedAt: new Date()
                } 
            },
            { new: true, session }
        );

        if (!withdrawal) {
            await bot.answerCallbackQuery(query.id, { text: "❌ Withdrawal not found or already processed" });
            return;
        }

        // If declined, mark referrals as not withdrawn
        if (action === 'decline') {
            await Referral.updateMany(
                { _id: { $in: withdrawal.referralIds } },
                { $set: { withdrawn: false } },
                { session }
            );
        }

        // Notify user
        const userMessage = action === 'complete'
            ? `✅ Withdrawal #${withdrawal.withdrawalId} Completed!\n\n` +
              `Amount: ${withdrawal.amount} USDT\n` +
              `Wallet: ${withdrawal.walletAddress}\n\n` +
              `Funds have been sent to your wallet.`
            : `❌ Withdrawal #${withdrawal.withdrawalId} Declined\n\n` +
              `Amount: ${withdrawal.amount} USDT\n` +
              `Contact support for more information.`;

        await bot.sendMessage(withdrawal.userId, userMessage);

        // Update all admin messages
        const statusText = action === 'complete' ? '✅ Completed' : '❌ Declined';
        const processedBy = `Processed by: @${from.username || `admin_${from.id.toString().slice(-4)}`}`;
        
        const transformedKeyboard = {
            inline_keyboard: [
                [{
                    text: statusText,
                    callback_data: 'processed',
                    disabled: true
                }]
            ]
        };

        // Update each admin message
        if (withdrawal.adminMessages?.length) {
            await Promise.all(withdrawal.adminMessages.map(async adminMsg => {
                if (!adminMsg?.adminId || !adminMsg?.messageId) return;
                
                try {
                    const updatedText = `${adminMsg.originalText}\n\n` +
                                      `Status: ${statusText}\n` +
                                      `${processedBy}\n` +
                                      `Processed at: ${new Date().toLocaleString()}`;

                    await bot.editMessageText(updatedText, {
                        chat_id: adminMsg.adminId,
                        message_id: adminMsg.messageId,
                        reply_markup: transformedKeyboard,
                        parse_mode: "Markdown"
                    });
                } catch (err) {
                    console.error(`Failed to update admin ${adminMsg.adminId}:`, err.message);
                }
            }));
        }

        await session.commitTransaction();
        await bot.answerCallbackQuery(query.id, { 
            text: `✔️ Withdrawal ${action === 'complete' ? 'completed' : 'declined'}` 
        });

    } catch (error) {
        await session.abortTransaction();
        console.error('Withdrawal processing error:', error);
        
        let errorMsg = "❌ Processing failed";
        if (error.message.includes("network error")) {
            errorMsg = "⚠️ Network issue - please retry";
        }
        
        await bot.answerCallbackQuery(query.id, { text: errorMsg });
    } finally {
        session.endSession();
    }
});

//referral tracking for referrals rewards
async function handleReferralActivation(tracker) {
    try {
        // Update both tracker and referral
        tracker.status = 'active';
        tracker.dateActivated = new Date();
        await tracker.save();

        if (tracker.referral) {
            await Referral.findByIdAndUpdate(tracker.referral, {
                status: 'active',
                dateActivated: new Date()
            });
        }

        // Send notification
        await bot.sendMessage(
            tracker.referrerUserId,
            `🎉 One of your referrals just qualified!\n\n` +
            `You've received a bonus of 0.5 USDT.`
        );
    } catch (error) {
        console.error('Activation error:', error);
    }
}

async function trackStars(userId, stars, type) {
    try {
        const tracker = await ReferralTracker.findOne({ referredUserId: userId.toString() });
        if (!tracker) return;

        // Update star counts based on transaction type
        if (type === 'buy') tracker.totalBoughtStars += stars || 0;
        if (type === 'sell') tracker.totalSoldStars += stars || 0;

        const totalStars = tracker.totalBoughtStars + tracker.totalSoldStars;
        
        // Activation logic (100+ stars or premium)
        if ((totalStars >= 100 || tracker.premiumActivated) && tracker.status === 'pending') {
            tracker.status = 'active';
            tracker.dateActivated = new Date();
            await tracker.save();

            // Update corresponding referral record
            await Referral.findOneAndUpdate(
                { referredUserId: userId },
                { 
                    status: 'active',
                    dateActivated: new Date() 
                }
            );

            // Notify referrer
            await bot.sendMessage(
                tracker.referrerUserId,
                `🎉 Your referral @${tracker.referredUsername} just became active!\n` +
                `You earned 0.5 USDT referral bonus.`
            );
        } else {
            await tracker.save();
        }
    } catch (error) {
        console.error('Tracking error:', error);
    }
}

async function trackPremiumActivation(userId) {
    try {
        const tracker = await ReferralTracker.findOne({ referredUserId: userId.toString() });
        if (!tracker) return;

        if (!tracker.premiumActivated) {
            tracker.premiumActivated = true;
            if (tracker.status === 'pending') {
                await handleReferralActivation(tracker);
            } else {
                await tracker.save();
            }
        }
    } catch (error) {
        console.error('Premium activation error:', error);
    }
}


//end of referral track 

//ban system 

bot.onText(/\/ban(?:\s+(\d+))(?:\s+(.+?))?(?:\s+--duration=(\d+)([ymd]))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const requesterId = msg.from.id.toString();
    
    if (!adminIds.includes(requesterId)) {
        return bot.sendMessage(chatId, '⛔ **Access Denied**\n\nAdministrator privileges required to execute this command.', {
            parse_mode: 'Markdown',
            reply_to_message_id: msg.message_id
        });
    }
    
    if (!match[1]) return sendBanUsageExample(chatId, msg.message_id);
    
    const userId = match[1];
    const reason = match[2] || 'Terms of service violation';
    const durationValue = match[3] ? parseInt(match[3]) : null;
    const durationUnit = match[4] || null;
    
    const existing = await BannedUser.findOne({ users: userId });
    if (existing) {
        return bot.sendMessage(chatId, `⚠️ User ${userId} is currently banned from the system.`, {
            reply_to_message_id: msg.message_id
        });
    }
    
    await BannedUser.updateOne(
        {}, 
        { $push: { users: userId } },
        { upsert: true }
    );
    
    let banDuration = '';
    if (durationValue && durationUnit) {
        banDuration = durationUnit === 'y' ? `${durationValue} year(s)` :
                     durationUnit === 'm' ? `${durationValue} month(s)` :
                     `${durationValue} day(s)`;
    }
    
    try {
        const userNotification = `🔴 **ACCOUNT SUSPENSION NOTICE**\n\n` +
            `Your account has been suspended due to: ${reason}\n` +
            (banDuration ? `**Suspension Period**: ${banDuration}\n\n` : '\n') +
            `**Restrictions in Effect**:\n` +
            `• Service access suspended\n` +
            `• Transaction capabilities disabled\n` +
            `• Account functionality restricted\n\n` +
            `For appeals or inquiries, please contact our support team.`;
        
        await bot.sendMessage(userId, userNotification, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error('User notification delivery failed:', error);
    }
    
    const adminConfirmation = `✅ **User Suspension Applied**\n\n` +
        `**User ID**: ${userId}\n` +
        `**Reason**: ${reason}\n` +
        (banDuration ? `**Duration**: ${banDuration}\n` : `**Type**: Permanent\n`) +
        `**Administrator**: ${msg.from.username ? `@${msg.from.username}` : msg.from.first_name}`;
    
    await bot.sendMessage(chatId, adminConfirmation, {
        parse_mode: 'Markdown',
        reply_to_message_id: msg.message_id
    });
});

bot.onText(/\/warn(?:\s+(\d+))(?:\s+(.+))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const requesterId = msg.from.id.toString();
    
    if (!adminIds.includes(requesterId)) {
        return bot.sendMessage(chatId, '⛔ **Access Denied**\n\nAdministrator privileges required to execute this command.', {
            parse_mode: 'Markdown',
            reply_to_message_id: msg.message_id
        });
    }
    
    if (!match[1]) return sendWarnUsageExample(chatId, msg.message_id);
    
    const userId = match[1];
    const reason = match[2] || 'Policy compliance concern';
    
    let userWarnings = await UserWarning.findOne({ userId: userId });
    if (!userWarnings) {
        userWarnings = new UserWarning({ userId: userId, warnings: [] });
    }
    
    userWarnings.warnings.push({
        reason: reason,
        issuedBy: requesterId,
        timestamp: new Date()
    });
    
    await userWarnings.save();
    
    const warningCount = userWarnings.warnings.length;
    
    try {
        const userNotification = `⚠️ **ACCOUNT WARNING**\n\n` +
            `You have received a warning regarding: ${reason}\n\n` +
            `**Warning Count**: ${warningCount}\n\n` +
            `Please review our terms of service and adjust your account activity accordingly. ` +
            `Continued violations may result in permanent account suspension.\n\n` +
            `If you have questions about this warning, please contact our support team.`;
        
        await bot.sendMessage(userId, userNotification, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error('Warning notification delivery failed:', error);
    }
    
    const adminConfirmation = `⚠️ **Warning Issued**\n\n` +
        `**User ID**: ${userId}\n` +
        `**Reason**: ${reason}\n` +
        `**Total Warnings**: ${warningCount}\n` +
        `**Administrator**: ${msg.from.username ? `@${msg.from.username}` : msg.from.first_name}`;
    
    await bot.sendMessage(chatId, adminConfirmation, {
        parse_mode: 'Markdown',
        reply_to_message_id: msg.message_id
    });
});

bot.onText(/\/unban (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const requesterId = msg.from.id.toString();
    
    if (!adminIds.includes(requesterId)) {
        return bot.sendMessage(chatId, '⛔ **Access Denied**\n\nAdministrator privileges required to execute this command.', {
            parse_mode: 'Markdown',
            reply_to_message_id: msg.message_id
        });
    }
    
    const userId = match[1];
    const bannedUser = await BannedUser.findOne({ users: userId });
    
    if (!bannedUser) {
        return bot.sendMessage(chatId, `⚠️ User ${userId} is not currently banned.`, {
            reply_to_message_id: msg.message_id
        });
    }
    
    await BannedUser.updateOne({}, { $pull: { users: userId } });
    
    try {
        const reinstatementMessage = `✅ **Account Reinstatement**\n\n` +
            `Your account has been reinstated and full access has been restored.\n\n` +
            `Thank you for your cooperation during the review process.`;
        
        await bot.sendMessage(userId, reinstatementMessage, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error('Reinstatement notification delivery failed:', error);
    }
    
    const adminConfirmation = `✅ **User Reinstatement Completed**\n\n` +
        `**User ID**: ${userId}\n` +
        `**Administrator**: ${msg.from.username ? `@${msg.from.username}` : msg.from.first_name}`;
    
    await bot.sendMessage(chatId, adminConfirmation, {
        parse_mode: 'Markdown',
        reply_to_message_id: msg.message_id
    });
});

function sendBanUsageExample(chatId, replyTo) {
    return bot.sendMessage(chatId,
        `📋 **Ban Command Usage**\n\n` +
        `\`/ban <user_id> [reason] [--duration=<value><y|m|d>]\`\n\n` +
        `**Examples**:\n` +
        `• \`/ban 12345678 "Terms of service violation"\`\n` +
        `• \`/ban 78901234 "Unauthorized activity" --duration=30d\``,
        {
            parse_mode: 'Markdown',
            reply_to_message_id: replyTo
        }
    );
}

function sendWarnUsageExample(chatId, replyTo) {
    return bot.sendMessage(chatId,
        `📋 **Warning Command Usage**\n\n` +
        `\`/warn <user_id> [reason]\`\n\n` +
        `**Examples**:\n` +
        `• \`/warn 12345678 "Suspicious account activity"\`\n` +
        `• \`/warn 78901234 "Policy compliance reminder"\``,
        {
            parse_mode: 'Markdown',
            reply_to_message_id: replyTo
        }
    );
}

bot.onText(/\/start(.*)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const username = msg.from.username || 'user';
    const deepLinkParam = match[1]?.trim();
    
    try {
        let user = await User.findOne({ id: chatId });
        if (!user) user = await User.create({ id: chatId, username });
        
        try {
            await bot.sendSticker(chatId, 'CAACAgIAAxkBAAEOfYRoJQbAGJ_uoVDJp5O3xyvEPR77BAACbgUAAj-VzAqGOtldiLy3NTYE');
        } catch (stickerError) {
            console.error('Failed to send sticker:', stickerError);
        }
        
        await bot.sendMessage(chatId, `👋 Welcome to StarStore, @${username}! ✨\n\nUse the app to purchase stars and enjoy exclusive benefits!`, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🚀 Launch StarStore', web_app: { url: `https://starstore.site?startapp=home_${chatId}` } }],
                    [{ text: '👥 Join Community', url: 'https://t.me/StarStore_Chat' }]
                ]
            }
        });
        
        if (deepLinkParam?.startsWith('ref_')) {
            const referrerUserId = deepLinkParam.split('_')[1];
            
            if (!referrerUserId || referrerUserId === chatId.toString()) return;
            if (!/^\d+$/.test(referrerUserId)) return;
            
            const existing = await ReferralTracker.findOne({ referredUserId: chatId.toString() });
            if (!existing) {
                const referral = await Referral.create({
                    referrerUserId,
                    referredUserId: chatId.toString(),
                    status: 'pending',
                    dateReferred: new Date()
                });
                
                await ReferralTracker.create({
                    referral: referral._id,
                    referrerUserId,
                    referredUserId: chatId.toString(),
                    referredUsername: username,
                    status: 'pending',
                    dateReferred: new Date()
                });
                
                await bot.sendMessage(referrerUserId, `🎉 Someone used your referral link and joined StarStore!`);
            }
        }
    } catch (error) {
        console.error('Start command error:', error);
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

bot.onText(/\/reply (\d+)(?:\s+(.+))?/, async (msg, match) => {
    try {
        // Verify admin (using your existing adminIds)
        if (!adminIds.includes(String(msg.from.id))) {
            return await bot.sendMessage(msg.chat.id, "❌ Unauthorized");
        }

        const userId = match[1];
        const textMessage = match[2] || '';

        // Case 1: Text-only reply
        if (textMessage && !msg.reply_to_message) {
            if (textMessage.length > 4000) {
                throw new Error("Message exceeds 4000 character limit");
            }
            await bot.sendMessage(userId, `📨 Admin Reply:\n\n${textMessage}`);
        }
        // Case 2: Media reply (when replying to a message)
        else if (msg.reply_to_message) {
            const mediaMsg = msg.reply_to_message;
            
            if (mediaMsg.photo) {
                await bot.sendPhoto(
                    userId, 
                    mediaMsg.photo.slice(-1)[0].file_id,
                    { caption: textMessage || '📨 Admin Reply' }
                );
            } 
            else if (mediaMsg.document) {
                await bot.sendDocument(
                    userId,
                    mediaMsg.document.file_id,
                    { caption: textMessage || '📨 Admin Reply' }
                );
            }
            else if (textMessage) {
                await bot.sendMessage(userId, `📨 Admin Reply:\n\n${textMessage}`);
            }
            else {
                throw new Error("No message content found");
            }
        }
        else {
            throw new Error("No message content provided");
        }

        await bot.sendMessage(msg.chat.id, "✅ Message delivered to user");
    } 
    catch (error) {
        let errorMsg = `❌ Failed to send: ${error.message}`;
        
        if (error.response?.error_code === 403) {
            errorMsg = "❌ User has blocked the bot or doesn't exist";
        }
        else if (error.message.includes("chat not found")) {
            errorMsg = "❌ User hasn't started a chat with the bot";
        }
        
        await bot.sendMessage(msg.chat.id, errorMsg);
        console.error("Reply command error:", error);
    }
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



// Get transaction history and should NOT TOUCH THIS CODE
app.get('/api/transactions/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        
        // Get both buy and sell orders for the user
        const buyOrders = await BuyOrder.find({ telegramId: userId })
            .sort({ dateCreated: -1 })
            .lean();
        
        const sellOrders = await SellOrder.find({ telegramId: userId })
            .sort({ dateCreated: -1 })
            .lean();

        // Combine and format the data
        const transactions = [
            ...buyOrders.map(order => ({
                id: order.id,
                type: 'Buy Stars',
                amount: order.stars,
                status: order.status.toLowerCase(),
                date: order.dateCreated,
                details: `Buy order for ${order.stars} stars`,
                usdtValue: order.amount
            })),
            ...sellOrders.map(order => ({
                id: order.id,
                type: 'Sell Stars',
                amount: order.stars,
                status: order.status.toLowerCase(),
                date: order.dateCreated,
                details: `Sell order for ${order.stars} stars`,
                usdtValue: null 
            }))
        ];

        res.json(transactions);
    } catch (error) {
        console.error('Error fetching transactions:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get referral history
app.get('/api/referrals/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        
        const referrals = await Referral.find({ referrerUserId: userId })
            .sort({ dateReferred: -1 })
            .lean();
        
        // Format referral data
        const formattedReferrals = await Promise.all(referrals.map(async referral => {
            const referredUser = await User.findOne({ id: referral.referredUserId }).lean();
            
            return {
                id: referral._id.toString(),
                name: referredUser?.username || 'Unknown User',
                status: referral.status.toLowerCase(),
                date: referral.dateReferred,
                details: `Referred user ${referredUser?.username || referral.referredUserId}`,
                amount: 0.5 // Fixed bonus amount or calculate based on your logic
            };
        }));

        res.json(formattedReferrals);
    } catch (error) {
        console.error('Error fetching referrals:', error);
        res.status(500).json({ error: 'Internal server error' });
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

        
//feedback on sell orders
bot.onText(/\/sell_complete (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    
    if (!adminIds.includes(chatId.toString())) {
        return bot.sendMessage(chatId, '❌ Unauthorized: Only admins can use this command.');
    }

    const orderId = match[1].trim();
    const order = await SellOrder.findOne({ id: orderId });
    
    if (!order) {
        return bot.sendMessage(chatId, `❌ Order ${orderId} not found.`);
    }

    try {
        // Send confirmation to user
        const confirmationMessage = `🎉 Order #${orderId} Completed!\n\n` +
                                 `We've successfully processed your sell order for ${order.stars} stars.\n\n` +
                                 `Payment was sent to:\n` +
                                 `\`${order.walletAddress}\`\n\n` +
                                 `We'd love to hear about your experience!`;
        
        const feedbackKeyboard = {
            inline_keyboard: [
                [{ text: "⭐ Leave Feedback", callback_data: `start_feedback_${orderId}` }],
                [{ text: "Skip Feedback", callback_data: `skip_feedback_${orderId}` }]
            ]
        };

        await bot.sendMessage(
            order.telegramId,
            confirmationMessage,
            { 
                parse_mode: 'Markdown',
                reply_markup: feedbackKeyboard 
            }
        );

        await bot.sendMessage(chatId, `✅ Sent completion notification for order ${orderId} to user @${order.username}`);
        
    } catch (error) {
        if (error.response?.error_code === 403) {
            await bot.sendMessage(chatId, `❌ Failed to notify user @${order.username} (user blocked the bot)`);
        } else {
            console.error('Notification error:', error);
            await bot.sendMessage(chatId, `❌ Failed to send notification for order ${orderId}`);
        }
    }
});

// Feedback session state management
const feedbackSessions = {};
const completedFeedbacks = new Set(); // Track users who have already submitted feedback

bot.on('callback_query', async (query) => {
    const data = query.data;
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    
    if (data.startsWith('start_feedback_')) {
        const orderId = data.split('_')[2];
        const order = await SellOrder.findOne({ id: orderId });
        
        if (!order) return;
        
        // Check if user has already completed feedback for this order
        if (completedFeedbacks.has(chatId.toString() + '_' + orderId)) {
            await bot.sendMessage(chatId, "You have already submitted feedback for this order. Thank you!");
            await bot.answerCallbackQuery(query.id);
            return;
        }
        
        // Initialize feedback session
        feedbackSessions[chatId] = {
            orderId: orderId,
            telegramId: order.telegramId,
            username: order.username,
            currentQuestion: 1, // 1 = satisfaction, 2 = reasons, 3 = suggestions, 4 = additional info
            responses: {},
            active: true
        };

        // Ask first question
        await askFeedbackQuestion(chatId, 1);
        await bot.answerCallbackQuery(query.id);
        
    } else if (data.startsWith('skip_feedback_')) {
        const orderId = data.split('_')[2];
        
        // Update message to show feedback was skipped
        await bot.editMessageReplyMarkup(
            { inline_keyboard: [[{ text: "✓ Feedback Skipped", callback_data: 'feedback_skipped' }]] },
            { chat_id: chatId, message_id: messageId }
        );
        
        await bot.sendMessage(chatId, "Thank you for your order! We appreciate your business.");
        await bot.answerCallbackQuery(query.id);
        
    } else if (data.startsWith('feedback_rating_')) {
        // Handle rating selection
        const rating = parseInt(data.split('_')[2]);
        const session = feedbackSessions[chatId];
        
        if (session && session.active) {
            session.responses.satisfaction = rating;
            session.currentQuestion = 2;
            
            await askFeedbackQuestion(chatId, 2);
            await bot.answerCallbackQuery(query.id);
        }
    }
    // Add other feedback handlers here if needed
});

async function askFeedbackQuestion(chatId, questionNumber) {
    const session = feedbackSessions[chatId];
    if (!session) return;
    
    let questionText = '';
    let replyMarkup = {};
    
    switch(questionNumber) {
        case 1: // Satisfaction rating
            questionText = "How satisfied are you with our service? (1-5 stars)";
            replyMarkup = {
                inline_keyboard: [
                    [
                        { text: "⭐", callback_data: `feedback_rating_1` },
                        { text: "⭐⭐", callback_data: `feedback_rating_2` },
                        { text: "⭐⭐⭐", callback_data: `feedback_rating_3` },
                        { text: "⭐⭐⭐⭐", callback_data: `feedback_rating_4` },
                        { text: "⭐⭐⭐⭐⭐", callback_data: `feedback_rating_5` }
                    ],
                    [{ text: "Skip", callback_data: `feedback_skip_1` }]
                ]
            };
            break;
            
        case 2: // Reasons for rating
            questionText = "Could you tell us why you gave this rating?";
            replyMarkup = {
                inline_keyboard: [
                    [{ text: "Skip", callback_data: `feedback_skip_2` }]
                ]
            };
            break;
            
        case 3: // Suggestions
            questionText = "What could we improve or add to make your experience better?";
            replyMarkup = {
                inline_keyboard: [
                    [{ text: "Skip", callback_data: `feedback_skip_3` }]
                ]
            };
            break;
            
        case 4: // Additional info
            questionText = "Any additional comments? (Optional - you can skip this)";
            replyMarkup = {
                inline_keyboard: [
                    [{ text: "Skip and Submit", callback_data: `feedback_complete` }]
                ]
            };
            break;
    }
    
    // If we're moving to a new question, send it (but don't delete previous ones)
    if (questionText) {
        const message = await bot.sendMessage(chatId, questionText, { reply_markup: replyMarkup });
        session.lastQuestionMessageId = message.message_id;
    }
}

// Handle text responses to feedback questions
bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    
    const chatId = msg.chat.id.toString();
    const session = feedbackSessions[chatId];
    
    if (!session || !session.active) return;
    
    try {
        switch(session.currentQuestion) {
            case 2: // Reasons for rating
                session.responses.reasons = msg.text;
                session.currentQuestion = 3;
                await askFeedbackQuestion(chatId, 3);
                break;
                
            case 3: // Suggestions
                session.responses.suggestions = msg.text;
                session.currentQuestion = 4;
                await askFeedbackQuestion(chatId, 4);
                break;
                
            case 4: // Additional info
                session.responses.additionalInfo = msg.text;
                await completeFeedback(chatId);
                break;
        }
    } catch (error) {
        console.error('Feedback processing error:', error);
    }
});

async function completeFeedback(chatId) {
    const session = feedbackSessions[chatId];
    if (!session) return;
    
    try {
        // Save feedback to database
        const feedback = new Feedback({
            orderId: session.orderId,
            telegramId: session.telegramId,
            username: session.username,
            satisfaction: session.responses.satisfaction,
            reasons: session.responses.reasons,
            suggestions: session.responses.suggestions,
            additionalInfo: session.responses.additionalInfo
        });
        
        await feedback.save();
        
        // Add to completed feedbacks set
        completedFeedbacks.add(chatId.toString() + '_' + session.orderId);
        
        // Notify admins
        const adminMessage = `📝 New Feedback Received\n\n` +
                            `Order: ${session.orderId}\n` +
                            `User: @${session.username}\n` +
                            `Rating: ${session.responses.satisfaction}/5\n` +
                            `Reasons: ${session.responses.reasons || 'Not provided'}\n` +
                            `Suggestions: ${session.responses.suggestions || 'Not provided'}\n` +
                            `Additional Info: ${session.responses.additionalInfo || 'None'}`;
        
        for (const adminId of adminIds) {
            try {
                await bot.sendMessage(adminId, adminMessage);
            } catch (err) {
                console.error(`Failed to notify admin ${adminId}:`, err);
            }
        }
        
        // Thank user
        await bot.sendMessage(chatId, "Thank you for your feedback! We appreciate your time.");
        
    } catch (error) {
        console.error('Error saving feedback:', error);
        await bot.sendMessage(chatId, "Sorry, we couldn't save your feedback. Please try again later.");
    } finally {
        // Clean up session
        delete feedbackSessions[chatId];
    }
}

// Handle skip actions for feedback questions
bot.on('callback_query', async (query) => {
    const data = query.data;
    const chatId = query.message.chat.id;
    
    if (data.startsWith('feedback_skip_')) {
        const questionNumber = parseInt(data.split('_')[2]);
        const session = feedbackSessions[chatId];
        
        if (session) {
            if (questionNumber < 4) {
                // Move to next question
                session.currentQuestion = questionNumber + 1;
                await askFeedbackQuestion(chatId, session.currentQuestion);
            } else {
                // Complete feedback if on last question
                await completeFeedback(chatId);
            }
        }
        await bot.answerCallbackQuery(query.id);
        
    } else if (data === 'feedback_complete') {
        await completeFeedback(chatId);
        await bot.answerCallbackQuery(query.id);
    }
});
//end of sell order feedback



//notification for reversing orders
bot.onText(/\/sell_decline (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    
    if (!adminIds.includes(chatId.toString())) {
        return bot.sendMessage(chatId, '❌ Unauthorized: Only admins can use this command.');
    }

    const orderId = match[1].trim();
    const order = await SellOrder.findOne({ id: orderId });
    
    if (!order) {
        return bot.sendMessage(chatId, `❌ Order ${orderId} not found.`);
    }

    try {
        await bot.sendMessage(
            order.telegramId,
            `⚠️ Order #${orderId} Notification\n\n` +
            `Your order was canceled because the stars were reversed during our 21-day holding period.\n\n` +
            `Since the transaction cannot be completed after any reversal, you'll need to submit a new order if you still wish to sell your stars.\n\n` +
            `We'd appreciate your feedback to help us improve:`,
            {
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: "Provide Feedback", callback_data: `reversal_feedback_${orderId}` },
                            { text: "Skip", callback_data: `skip_feedback_${orderId}` }
                        ]
                    ]
                }
            }
        );

        await bot.sendMessage(chatId, `✅ Sent reversal notification for order ${orderId} to user @${order.username}`);
        
    } catch (error) {
        if (error.response?.error_code === 403) {
            await bot.sendMessage(chatId, `❌ Failed to notify user @${order.username} (user blocked the bot)`);
        } else {
            console.error('Notification error:', error);
            await bot.sendMessage(chatId, `❌ Failed to send notification for order ${orderId}`);
        }
    }
});

bot.on('callback_query', async (query) => {
    const data = query.data;
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    
    if (data.startsWith('reversal_feedback_')) {
        const orderId = data.split('_')[2];
        
        // Update buttons to show feedback submitted
        await bot.editMessageReplyMarkup(
            {
                inline_keyboard: [
                    [{ text: "✓ Feedback Submitted", callback_data: `feedback_submitted_${orderId}` }]
                ]
            },
            {
                chat_id: chatId,
                message_id: messageId
            }
        );
        
        // Prompt for feedback
        await bot.sendMessage(
            chatId,
            `Please tell us why the stars were reversed and how we can improve:`
        );
        
        // Set temporary state to collect feedback
        userFeedbackState[chatId] = {
            orderId: orderId,
            timestamp: Date.now()
        };
        
        await bot.answerCallbackQuery(query.id);
        
    } else if (data.startsWith('skip_feedback_')) {
        const orderId = data.split('_')[2];
        
        // Update buttons to show feedback skipped
        await bot.editMessageReplyMarkup(
            {
                inline_keyboard: [
                    [{ text: "✗ Feedback Skipped", callback_data: `feedback_skipped_${orderId}` }]
                ]
            },
            {
                chat_id: chatId,
                message_id: messageId
            }
        );
        
        await bot.answerCallbackQuery(query.id);
    }
});

// Handle feedback messages
bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    
    const chatId = msg.chat.id.toString();
    const feedbackState = userFeedbackState[chatId];
    
    if (feedbackState && Date.now() - feedbackState.timestamp < 600000) { // 10 minute window
        const orderId = feedbackState.orderId;
        const username = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
        
        // Notify admins
        const adminMessage = `📝 Reversal Feedback\n\n` +
                            `Order: ${orderId}\n` +
                            `User: ${username}\n` +
                            `Feedback: ${msg.text}`;
        
        adminIds.forEach(adminId => {
            bot.sendMessage(adminId, adminMessage);
        });
        
        // Confirm receipt
        await bot.sendMessage(chatId, `Thank you for your feedback!`);
        
        // Clear state
        delete userFeedbackState[chatId];
    }
});

// Temporary state storage
const userFeedbackState = {};

// Cleanup expired feedback states (runs hourly)
setInterval(() => {
    const now = Date.now();
    for (const [chatId, state] of Object.entries(userFeedbackState)) {
        if (now - state.timestamp > 600000) { // 10 minutes
            delete userFeedbackState[chatId];
        }
    }
}, 60 * 60 * 1000);

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



const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Webhook set to: ${WEBHOOK_URL}`);
});
