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

// Middleware
app.use(cors());
app.use(express.json());
app.use(bodyParser.json());
app.use(express.static('public'));

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
  referrerUserId: { type: String, required: true },
  referredUserId: { type: String, required: true },
  status: { type: String, enum: ['pending', 'active', 'completed'], default: 'pending' },
  withdrawn: { type: Boolean, default: false }, 
  dateReferred: { type: Date, default: Date.now }
});


const bannedUserSchema = new mongoose.Schema({
    users: Array
});




const cacheSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    username: { type: String, required: true },
    date: { type: Date, default: Date.now }
});

// ReferralWithdrawal Schema

const referralWithdrawalSchema = new mongoose.Schema({
    userId: String,
    username: String,
    amount: Number,
    walletAddress: String,
    referralIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Referral' }],
    status: { type: String, enum: ['pending', 'completed', 'declined'], default: 'pending' },
    createdAt: { type: Date, default: Date.now }
});


const referralTrackerSchema = new mongoose.Schema({
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
            
            if (order.isPremium) {
                await checkAndActivateReferral(order.telegramId, order.username, true);
            } else if (order.stars) {
                await updateReferralStars(order.telegramId, order.stars, 'buy');
                await checkAndActivateReferral(order.telegramId, order.username);
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
            order.status = 'completed';
            order.dateCompleted = new Date();
            
            await updateReferralStars(order.telegramId, order.stars, 'sell');
            await checkAndActivateReferral(order.telegramId, order.username);
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


bot.on('callback_query', async (query) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const { data, message, from } = query;
        
        if (!adminIds.includes(from.id.toString())) {
            await bot.answerCallbackQuery(query.id, { text: "Unauthorized action" });
            return;
        }

        const action = data.startsWith('complete_withdrawal_') ? 'complete' : 'decline';
        const withdrawalId = data.split('_')[2];

        await bot.answerCallbackQuery(query.id, { text: `Processing ${action}...` });

        const withdrawal = await ReferralWithdrawal.findOneAndUpdate(
            { _id: withdrawalId, status: 'pending' },
            { 
                $set: { 
                    status: action === 'complete' ? 'completed' : 'declined',
                    processedBy: from.id,
                    ...(action === 'complete' ? { completedAt: new Date() } : { declinedAt: new Date() })
                } 
            },
            { new: true, session }
        );

        if (!withdrawal) {
            await bot.answerCallbackQuery(query.id, { text: "Withdrawal not found or already processed" });
            return;
        }

        if (action === 'decline') {
            await Referral.updateMany(
                { _id: { $in: withdrawal.referralIds } },
                { $set: { withdrawn: false } },
                { session }
            );
        }

        const userMessage = action === 'complete'
            ? `Withdrawal #WD${withdrawal._id.toString().slice(-8).toUpperCase()} completed!\n\n` +
              `Amount: ${withdrawal.amount} USDT\n` +
              `Wallet: ${withdrawal.walletAddress}`
            : `Withdrawal #WD${withdrawal._id.toString().slice(-8).toUpperCase()} declined\n\n` +
              `Amount: ${withdrawal.amount} USDT\n` +
              `Contact support for details`;

        await bot.sendMessage(withdrawal.userId, userMessage);

        const statusText = action === 'complete' ? '✅ Completed' : '❌ Declined';
        const processedBy = `Processed by: @${from.username || `admin_${from.id.toString().slice(-4)}`}`;
        
        // Create a transformed button that shows the action taken
        const transformedKeyboard = {
            inline_keyboard: [
                [
                    { 
                        text: action === 'complete' ? "✅ Completed" : "❌ Declined", 
                        callback_data: `info_withdrawal_${withdrawal._id}` 
                    }
                ]
            ]
        };
        
        // Update all admin messages with transformed button
        if (withdrawal.adminMessages && withdrawal.adminMessages.length > 0) {
            await Promise.all(withdrawal.adminMessages.map(async adminMsg => {
                if (!adminMsg) return;
                
                try {
                    const originalText = adminMsg.originalText;
                    const updatedText = `${originalText}\n\nStatus: ${statusText}\n${processedBy}`;
                    
                    // Update message text and transform the button
                    await bot.editMessageText(updatedText, {
                        chat_id: adminMsg.adminId,
                        message_id: adminMsg.messageId,
                        reply_markup: transformedKeyboard
                    });
                } catch (err) {
                    console.error(`Failed to update admin message ${adminMsg.adminId}:`, err);
                }
            }));
        }

        // Add handler for the info button that does nothing but show info
        bot.on('callback_query', async (infoQuery) => {
            if (infoQuery.data.startsWith('info_withdrawal_')) {
                await bot.answerCallbackQuery(infoQuery.id, { 
                    text: `This withdrawal was already ${action === 'complete' ? 'completed' : 'declined'}.`,
                    show_alert: true
                });
            }
        });

        await session.commitTransaction();
        await bot.answerCallbackQuery(query.id, { text: `Withdrawal ${action}d successfully` });

    } catch (error) {
        await session.abortTransaction();
        console.error('Withdrawal processing error:', error);
        await bot.answerCallbackQuery(query.id, { text: "Error processing request" });
    } finally {
        session.endSession();
    }
});


//referral tracking for referrals rewards

async function checkAndActivateReferral(userId, username, isPremium = false) {
    const referral = await ReferralTracker.findOne({ referredUserId: userId });
    if (!referral) return false;

    if (isPremium && !referral.premiumActivated) {
        referral.status = 'active';
        referral.premiumActivated = true;
        referral.dateActivated = new Date();
        await referral.save();
        
        await bot.sendMessage(
            referral.referrerUserId,
            `🎉 Your referral @${username} activated premium!`
        );
        return true;
    }

    if (!isPremium && referral.status === 'pending') {
        const totalStars = referral.totalBoughtStars + referral.totalSoldStars;
        if (totalStars >= 100) {
            referral.status = 'active';
            referral.dateActivated = new Date();
            await referral.save();
            
            await bot.sendMessage(
                referral.referrerUserId,
                `🎉 Your referral @${username} reached ${totalStars} stars!`
            );
            return true;
        }
    }
    
    return false;
}

async function updateReferralStars(userId, stars, type) {
    const updateField = type === 'buy' ? 'totalBoughtStars' : 'totalSoldStars';
    await ReferralTracker.findOneAndUpdate(
        { referredUserId: userId },
        { $inc: { [updateField]: stars } }
    );
}




// Check if adminIds is already declared
if (typeof adminIds === 'undefined') {
    const adminIds = process.env.ADMIN_TELEGRAM_IDS ? 
        process.env.ADMIN_TELEGRAM_IDS.split(',').map(id => id.trim()) : 
        [];
}

bot.onText(/\/ban(?:\s+(\d+))(?:\s+(.+?))?(?:\s+--duration=(\d+)([ymd]))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const requesterId = msg.from.id.toString();

    // Authorization check
    if (!adminIds.includes(requesterId)) {
        return bot.sendMessage(chatId, '⛔ **Access Denied**\n\nAdministrator privileges required.', {
            parse_mode: 'Markdown',
            reply_to_message_id: msg.message_id
        });
    }

    if (!match[1]) return sendUsageExample(chatId, msg.message_id);

    const userId = match[1];
    const reason = match[2] || 'Terms of service violation';
    const durationValue = match[3] ? parseInt(match[3]) : null;
    const durationUnit = match[4] || null;

    // Check if already banned
    const existing = await BannedUser.findOne({ users: userId });
    if (existing) {
        return bot.sendMessage(chatId, `⚠️ User ${userId} is already banned.`, {
            reply_to_message_id: msg.message_id
        });
    }

    // Add to banned users array (simple schema)
    await BannedUser.updateOne(
        {}, 
        { $push: { users: userId } },
        { upsert: true }
    );

    // Calculate ban period text
    let banPeriod = '';
    if (durationValue && durationUnit) {
        banPeriod = durationUnit === 'y' ? `${durationValue} year(s)` :
                   durationUnit === 'm' ? `${durationValue} month(s)` :
                   `${durationValue} day(s)`;
    }

    // Authoritative ban notification
    try {
        const banMessage = `🔴 YOUR ACCOUNT HAS BEEN BANNED\n\n` +
            `**Reason**: ${reason}\n` +
            (banPeriod ? `**Duration**: ${banPeriod}\n\n` : '\n') +
            `**Restrictions Applied**:\n` +
            `• Order placement disabled\n` +
            `• Transaction abilities revoked\n` +
            `• Full account access suspended\n\n` +
            `You will continue receiving StarStore updates.\n\n` +
            `This decision was made after careful review of your account activity. ` +
            `If you believe this was made in error, please contact our support team.`;

        await bot.sendMessage(userId, banMessage, { parse_mode: 'Markdown' });
    } catch (e) {
        console.error('Failed to notify user:', e);
    }

    // Detailed admin confirmation
    const adminMessage = `✅ **Ban Executed**\n\n` +
        `▸ User: ${userId}\n` +
        `▸ Reason: ${reason}\n` +
        (banPeriod ? `▸ Duration: ${banPeriod}\n` : '▸ Type: Permanent\n') +
        `▸ Actioned by: ${msg.from.username ? `@${msg.from.username}` : msg.from.first_name}`;

    await bot.sendMessage(chatId, adminMessage, {
        parse_mode: 'Markdown',
        reply_to_message_id: msg.message_id
    });
});

function sendUsageExample(chatId, replyTo) {
    return bot.sendMessage(chatId,
        `📝 **Ban Command Usage**\n\n` +
        `\`/ban <user_id> [reason] [--duration=<value><y|m|d>]\`\n\n` +
        `**Examples**:\n` +
        `• \`/ban 12345678 "Fraudulent activity"\`\n` +
        `• \`/ban 78901234 "Policy violation" --duration=30d\``,
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
                    // Fixed Launch App button - uses the correct Telegram Web App URL format
                    [{ text: '🚀 Launch StarStore', web_app: { url: `https://starstore.site?startapp=home_${chatId}` } }],
                    // New Join Community button
                    [{ text: '👥 Join Community', url: 'https://t.me/StarStore_Chat' }]
                ]
            }
        });
        if (deepLinkParam?.startsWith('ref_')) {
            const referrerUserId = deepLinkParam.split('_')[1];
            
            // Check if user is trying to self-refer
            if (!referrerUserId || referrerUserId === chatId.toString()) {
                return;
            }
            
            // Validate referrerUserId format
            if (!/^\d+$/.test(referrerUserId)) {
                return;
            }
            
            // Check if this referral already exists
            const existing = await ReferralTracker.findOne({ referredUserId: chatId.toString() });
            if (!existing) {
                await ReferralTracker.create({
                    referrerUserId,
                    referredUserId: chatId.toString(),
                    referredUsername: username,
                    status: 'pending',
                    dateReferred: new Date()
                });
                
                // Send notification without sharing user ID
                await bot.sendMessage(referrerUserId, `🎉 Great news! Someone used your referral link and joined StarStore!`);
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

        
//reminder for sell order
const userSessions = {};
const completedOrders = new Set();
const userEngagement = {};

bot.onText(/\/remind (.+)/, async (msg, match) => {
    try {
        const chatId = msg.chat.id;
        if (!adminIds.includes(chatId.toString())) {
            return bot.sendMessage(chatId, '❌ Unauthorized: Only admins can use this command.');
        }

        const orderId = match[1].trim();
        const order = await SellOrder.findOne({ id: orderId });
        
        if (!order) {
            return bot.sendMessage(chatId, `❌ Order ${orderId} not found.`);
        }

        if (completedOrders.has(orderId)) {
            return bot.sendMessage(chatId, `❌ Order ${orderId} is already completed.`);
        }

        if (!userSessions[order.telegramId]) {
            userSessions[order.telegramId] = { 
                currentOrder: orderId,
                language: 'en',
                messageIds: [],
                reminderCount: 0,
                confirmed: false,
                reminderInterval: null,
                lastAction: 'init',
                messageReceived: false,
                messageOpened: false,
                attemptedChange: false
            };

            userEngagement[order.telegramId] = {
                orderId: orderId,
                firstSent: new Date(),
                lastReminded: null,
                openCount: 0,
                changeAttempts: 0,
                confirmed: false,
                remindersSent: 0,
                lastAction: 'initialized'
            };
        }

        await cleanupMessages(order.telegramId);
        const sentSuccessfully = await sendWalletConfirmation(order.telegramId, order);
        
        if (sentSuccessfully) {
            await bot.sendMessage(chatId, `✅ Sent wallet confirmation to user ${order.telegramId}`);
            sendAdminReport(order.telegramId, 'message_sent');
        } else {
            await bot.sendMessage(chatId, `❌ Failed to send confirmation to user ${order.telegramId}`);
        }
    } catch (error) {
        console.error('Error in /remind handler:', error);
    }
});

async function cleanupMessages(userId) {
    try {
        const session = userSessions[userId];
        if (!session || !session.messageIds) return;

        for (const msgId of session.messageIds) {
            try {
                await bot.deleteMessage(userId, msgId);
            } catch (e) {}
        }
        session.messageIds = [];
    } catch (error) {
        console.error('Error in cleanupMessages:', error);
    }
}

function ensureNonHexAddress(address) {
    if (!address) return address;
    
    if (address.startsWith('0x')) {
        const hexPart = address.substring(2);
        if (/^[0-9a-fA-F]+$/.test(hexPart)) {
            try {
                let result = '';
                for (let i = 0; i < hexPart.length; i += 2) {
                    const byte = hexPart.substr(i, 2);
                    const charCode = parseInt(byte, 16);
                    if (charCode >= 32 && charCode <= 126) {
                        result += String.fromCharCode(charCode);
                    } else {
                        return hexPart;
                    }
                }
                return result || hexPart;
            } catch {
                return hexPart;
            }
        }
    }
    return address;
}

async function sendWalletConfirmation(userId, order) {
    try {
        const session = userSessions[userId] || { language: 'en', messageIds: [] };
        const isRussian = session.language === 'ru';
        const displayAddress = ensureNonHexAddress(order.walletAddress);
        
        const message = isRussian ? 
            `👋 Привет, ${order.username}!\n\nМы готовим к завершению ваш заказ #${order.id}.\n\nКошелек для выплаты: ${displayAddress}\n\nЭто верный адрес?` :
            `👋 Hello ${order.username}!\n\nWe're about to complete your sell order #${order.id}.\n\nPayout wallet: ${displayAddress}\n\nIs this address correct?`;

        const keyboard = {
            inline_keyboard: [
                [
                    { text: isRussian ? '✅ Подтвердить' : '✅ Confirm', callback_data: `confirm_wallet_${order.id}` },
                    { text: isRussian ? '✏️ Изменить' : '✏️ Change', callback_data: `change_wallet_${order.id}` }
                ],
                [
                    { text: isRussian ? '🌐 Русский' : '🌐 English', callback_data: `toggle_lang_${order.id}` }
                ]
            ]
        };

        const sentMessage = await bot.sendMessage(userId, message, {
            reply_markup: keyboard
        });

        session.messageIds = [sentMessage.message_id];
        session.messageReceived = true;
        session.lastAction = 'message_sent';
        userSessions[userId] = session;

        if (userEngagement[userId]) {
            userEngagement[userId].lastReminded = new Date();
            userEngagement[userId].remindersSent++;
            userEngagement[userId].lastAction = 'reminder_sent';
        }

        if (!session.reminderInterval) {
            startReminders(userId, order);
        }

        return true;
    } catch (error) {
        console.error('Error sending wallet confirmation:', error);
        return false;
    }
}

function startReminders(userId, order) {
    try {
        const session = userSessions[userId];
        if (!session) return;

        session.reminderInterval = setInterval(async () => {
            try {
                if (!userSessions[userId] || userSessions[userId].confirmed) {
                    clearInterval(session.reminderInterval);
                    return;
                }
                
                session.reminderCount++;
                userSessions[userId] = session;

                if (session.reminderCount <= 12) {
                    await cleanupMessages(userId);
                    const sentSuccessfully = await sendWalletConfirmation(userId, order);
                    if (sentSuccessfully) {
                        sendAdminReport(userId, 'reminder_sent');
                    }
                } else {
                    await endSession(userId, order.id);
                    sendAdminReport(userId, 'session_ended');
                }
            } catch (error) {
                console.error('Error in reminder interval:', error);
            }
        }, 2 * 60 * 60 * 1000);
    } catch (error) {
        console.error('Error in startReminders:', error);
    }
}

async function endSession(userId, orderId) {
    try {
        const session = userSessions[userId];
        if (!session) return;

        if (session.reminderInterval) {
            clearInterval(session.reminderInterval);
        }

        const isRussian = session.language === 'ru';
        await cleanupMessages(userId);
        await bot.sendMessage(
            userId,
            isRussian ? 
                '❌ Сессия завершена. Пожалуйста, свяжитесь с поддержкой для завершения вашего заказа.' :
                '❌ Session ended. Please contact support to complete your order.'
        );

        if (userEngagement[userId]) {
            userEngagement[userId].lastAction = 'session_ended';
            userEngagement[userId].completed = false;
        }

        completedOrders.add(orderId);
        delete userSessions[userId];
    } catch (error) {
        console.error('Error in endSession:', error);
    }
}

async function sendAdminReport(userId, action) {
    try {
        const engagement = userEngagement[userId];
        if (!engagement) return;

        const order = await SellOrder.findOne({ id: engagement.orderId });
        if (!order) return;

        let status = '';
        switch(action) {
            case 'message_sent':
                status = '📤 Message sent to user';
                break;
            case 'reminder_sent':
                status = '🔔 Reminder sent to user';
                break;
            case 'message_opened':
                status = '👀 User opened message';
                break;
            case 'session_ended':
                status = '⏱ Session ended (no response)';
                break;
            default:
                status = 'ℹ️ User activity';
        }

        const report = `📊 ${status}\n\n` +
                      `Order: ${order.id}\n` +
                      `User: @${order.username}\n` +
                      `Wallet: ${order.walletAddress}\n` +
                      `Last action: ${engagement.lastAction}\n` +
                      `Reminders sent: ${engagement.remindersSent}\n` +
                      `Opened count: ${engagement.openCount}\n` +
                      `Change attempts: ${engagement.changeAttempts}\n` +
                      `First sent: ${engagement.firstSent.toLocaleString()}\n` +
                      `Last interaction: ${engagement.lastInteraction ? engagement.lastInteraction.toLocaleString() : 'None'}`;

        for (const adminId of adminIds) {
            try {
                await bot.sendMessage(adminId, report);
            } catch (error) {
                console.error('Error sending report to admin:', error);
            }
        }
    } catch (error) {
        console.error('Error generating admin report:', error);
    }
}

bot.on('callback_query', async (query) => {
    try {
        const data = query.data;
        const userId = query.message.chat.id.toString();
        const session = userSessions[userId];
        
        if (!session) return;

        session.messageOpened = true;
        session.lastAction = 'message_opened';
        userSessions[userId] = session;

        if (userEngagement[userId]) {
            userEngagement[userId].openCount++;
            userEngagement[userId].lastAction = 'message_opened';
            userEngagement[userId].lastInteraction = new Date();
        }

        sendAdminReport(userId, 'message_opened');

        if (data.startsWith('confirm_wallet_')) {
            const orderId = data.split('_')[2];
            const order = await SellOrder.findOne({ id: orderId });
            
            if (!order) return;
            
            const isRussian = session.language === 'ru';
            session.confirmed = true;
            userSessions[userId] = session;
            
            if (session.reminderInterval) {
                clearInterval(session.reminderInterval);
            }
            
            await cleanupMessages(userId);
            await bot.sendMessage(
                userId,
                isRussian ? 
                    '✅ Адрес кошелька подтвержден! Администраторы уведомлены.' :
                    '✅ Wallet address confirmed! Admins have been notified.'
            );

            if (userEngagement[userId]) {
                userEngagement[userId].confirmed = true;
                userEngagement[userId].lastAction = 'wallet_confirmed';
                userEngagement[userId].completionTime = new Date();
            }

            sendAdminReport(userId, 'wallet_confirmed');
            completedOrders.add(orderId);
            delete userSessions[userId];
            await bot.answerCallbackQuery(query.id);
            
        } else if (data.startsWith('change_wallet_')) {
            const orderId = data.split('_')[2];
            const order = await SellOrder.findOne({ id: orderId });
            
            if (!order) return;
            
            const isRussian = session.language === 'ru';
            
            session.attemptedChange = true;
            session.lastAction = 'change_attempted';
            userSessions[userId] = session;

            if (userEngagement[userId]) {
                userEngagement[userId].changeAttempts++;
                userEngagement[userId].lastAction = 'change_attempted';
            }
            
            await cleanupMessages(userId);
            await bot.sendMessage(
                userId,
                isRussian ? 
                    'Пожалуйста, введите ваш новый USDT (TON) адрес кошелька:' :
                    'Please enter your new USDT (TON) wallet address:'
            );
            
            session.awaiting = 'wallet';
            session.currentOrder = orderId;
            userSessions[userId] = session;
            
            await bot.answerCallbackQuery(query.id);
            
        } else if (data.startsWith('toggle_lang_')) {
            const orderId = data.split('_')[2];
            const order = await SellOrder.findOne({ id: orderId });
            
            if (!order) return;
            
            session.language = session.language === 'en' ? 'ru' : 'en';
            session.lastAction = 'language_changed';
            userSessions[userId] = session;

            if (userEngagement[userId]) {
                userEngagement[userId].lastAction = 'language_changed';
            }
            
            await cleanupMessages(userId);
            await sendWalletConfirmation(userId, order);
            await bot.answerCallbackQuery(query.id);
        }
    } catch (error) {
        console.error('Error in callback_query handler:', error);
    }
});

bot.on('message', async (msg) => {
    try {
        if (!msg.text || msg.text.startsWith('/')) return;
        
        const userId = msg.chat.id.toString();
        const session = userSessions[userId];
        
        if (!session || !session.awaiting) return;
        
        if (session.awaiting === 'wallet') {
            if (msg.text.length < 10 || msg.text.length > 64) {
                const isRussian = session.language === 'ru';
                return bot.sendMessage(
                    userId,
                    isRussian ? 
                        '❌ Неверный формат адреса. Пожалуйста, введите действительный адрес кошелька:' :
                        '❌ Invalid address format. Please enter a valid wallet address:'
                );
            }
            
            session.newWallet = msg.text.trim();
            session.awaiting = 'memo';
            session.lastAction = 'wallet_received';
            userSessions[userId] = session;

            if (userEngagement[userId]) {
                userEngagement[userId].lastAction = 'wallet_received';
            }
            
            const isRussian = session.language === 'ru';
            const keyboard = {
                inline_keyboard: [[
                    { 
                        text: isRussian ? '⏭ Пропустить' : '⏭ Skip', 
                        callback_data: `skip_memo_${session.currentOrder}`
                    }
                ]]
            };
            
            await cleanupMessages(userId);
            await bot.sendMessage(
                userId,
                isRussian ? 
                    'Если ваш кошелек требует MEMO/тег, пожалуйста, введите его сейчас. Или нажмите "Пропустить":' :
                    'If your wallet requires a MEMO/tag, please enter it now. Or click "Skip":',
                { reply_markup: keyboard }
            );
            
        } else if (session.awaiting === 'memo') {
            await completeWalletUpdate(userId, session, msg.text);
        }
    } catch (error) {
        console.error('Error in message handler:', error);
    }
});

async function completeWalletUpdate(userId, session, memo) {
    try {
        const order = await SellOrder.findOne({ id: session.currentOrder });
        if (!order) return;
        
        const isRussian = session.language === 'ru';
        order.walletAddress = session.newWallet;
        if (memo) order.memo = memo;
        order.addressConfirmed = true;
        await order.save();
        
        let userMessage = isRussian ?
            `✅ Данные кошелька обновлены!\n\nАдрес: ${session.newWallet}` :
            `✅ Wallet details updated!\n\nAddress: ${session.newWallet}`;
        
        if (memo) {
            userMessage += isRussian ?
                `\nMEMO: ${memo}` :
                `\nMEMO: ${memo}`;
        }
        
        session.lastAction = 'wallet_updated';
        userSessions[userId] = session;

        if (userEngagement[userId]) {
            userEngagement[userId].lastAction = 'wallet_updated';
            userEngagement[userId].walletChanged = true;
        }
        
        await cleanupMessages(userId);
        await bot.sendMessage(userId, userMessage);

        sendAdminReport(userId, 'wallet_updated');
        
        completedOrders.add(order.id);
        if (session.reminderInterval) {
            clearInterval(session.reminderInterval);
        }
        delete userSessions[userId];
    } catch (error) {
        console.error('Error in completeWalletUpdate:', error);
    }
}



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
