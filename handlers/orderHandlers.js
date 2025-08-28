const { BuyOrder, SellOrder, BannedUser, generateOrderId } = require('../models');
const { adminIds } = require('../config');
const { sanitizeUsername } = require('../utils/helpers');

// Note: bot instance and createTelegramInvoice will be passed from server.js
let bot;
let createTelegramInvoice;

// Initialize function to set dependencies
const initializeHandlers = (botInstance, createInvoiceFn) => {
    bot = botInstance;
    createTelegramInvoice = createInvoiceFn;
};

// Buy Order Handler (orders/create)
const handleBuyOrder = async (req, res) => {
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
};

// Sell Order Handler (sell-orders)
const handleSellOrder = async (req, res) => {
    try {
        const { 
            telegramId, 
            username = '', 
            stars, 
            walletAddress, 
            memoTag = '' 
        } = req.body;
        
        if (!telegramId || !stars || !walletAddress) {
            return res.status(400).json({ error: "Missing required fields" });
        }

        const bannedUser = await BannedUser.findOne({ users: telegramId.toString() });
        if (bannedUser) {
            return res.status(403).json({ error: "You are banned from placing orders" });
        }

        // Check for existing pending orders for this user
        const existingOrder = await SellOrder.findOne({ 
            telegramId: telegramId,
            status: "pending",
            sessionExpiry: { $gt: new Date() } 
        });

        if (existingOrder) {
            return res.status(409).json({ 
                error: "You already have a pending order. Please complete or wait for it to expire before creating a new one.",
                existingOrderId: existingOrder.id
            });
        }

        // Generate unique session token for this user and order
        const sessionToken = generateSessionToken(telegramId);
        const sessionExpiry = new Date(Date.now() + 15 * 60 * 1000); 

        const order = new SellOrder({
            id: generateOrderId(),
            telegramId,
            username: sanitizeUsername(username),
            stars,
            walletAddress,
            memoTag,
            status: "pending", 
            telegram_payment_charge_id: "temp_" + Date.now(),
            reversible: true,
            dateCreated: new Date(),
            adminMessages: [],
            sessionToken: sessionToken, 
            sessionExpiry: sessionExpiry, 
            userLocked: telegramId 
        });

        await order.save();

        const userMessage = `🎉 Sell order received!\n\nOrder ID: ${order.id}\nStars: ${stars}\nStatus: Pending\n\nPlease send ${stars} stars to complete your order.`;
        await bot.sendMessage(telegramId, userMessage);

        const adminMessage = `🛒 New Sell Order!\n\nOrder ID: ${order.id}\nUser: @${username}\nStars: ${stars}\nWallet: ${walletAddress}`;
        
        const adminKeyboard = {
            inline_keyboard: [[
                { text: '✅ Complete', callback_data: `complete_sell_${order.id}` },
                { text: '❌ Decline', callback_data: `decline_sell_${order.id}` }
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
        console.error('Sell order creation error:', err);
        res.status(500).json({ error: 'Failed to create sell order' });
    }
};

// Cleanup Expired Orders
const cleanupExpiredOrders = async () => {
    try {
        const now = new Date();
        
        // Find expired sell orders
        const expiredOrders = await SellOrder.find({
            status: 'pending',
            sessionExpiry: { $lt: now }
        });

        for (const order of expiredOrders) {
            order.status = 'expired';
            await order.save();
            
            // Notify user about expired order
            try {
                await bot.sendMessage(order.telegramId, 
                    `⏰ Your sell order ${order.id} has expired. Please create a new order if you still want to sell stars.`
                );
            } catch (err) {
                console.error(`Failed to notify user about expired order ${order.id}:`, err);
            }
        }

        if (expiredOrders.length > 0) {
            console.log(`Cleaned up ${expiredOrders.length} expired orders`);
        }
    } catch (err) {
        console.error('Error cleaning up expired orders:', err);
    }
};

// Helper functions
function generateSessionToken(telegramId) {
    return `${telegramId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function sanitizeUsername(username) {
    if (!username) return null;
    return username.replace(/[^\w\d_]/g, '');
}

module.exports = {
    handleBuyOrder,
    handleSellOrder,
    cleanupExpiredOrders,
    initializeHandlers
};