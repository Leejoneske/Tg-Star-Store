require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const cors = require('cors');
const axios = require('axios');
const fetch = require('node-fetch');
const app = express();
const path = require('path');  
const zlib = require('zlib');
// Create Telegram bot or a stub in local/dev if no token is provided
let bot;
if (process.env.BOT_TOKEN) {
  bot = new TelegramBot(process.env.BOT_TOKEN, { webHook: true });
} else {
  console.warn('BOT_TOKEN not set. Using a no-op Telegram bot stub for local/dev.');
  bot = {
    setWebHook: async () => Promise.resolve(),
    sendMessage: async () => Promise.resolve({}),
    onText: () => {},
    on: () => {},
    processUpdate: () => {}
  };
}
const SERVER_URL = (process.env.RAILWAY_STATIC_URL || 
                   process.env.RAILWAY_PUBLIC_DOMAIN || 
                   'tg-star-store-production.up.railway.app');
const WEBHOOK_PATH = '/telegram-webhook';
const WEBHOOK_URL = `https://${SERVER_URL}${WEBHOOK_PATH}`;
// Import Telegram auth middleware (single import only)
let verifyTelegramAuth = (req, res, next) => next();
let requireTelegramAuth = (req, res, next) => next();
let isTelegramUser = () => true;
try {
    const mod = require('./middleware/telegramAuth');
    verifyTelegramAuth = mod.verifyTelegramAuth || verifyTelegramAuth;
    requireTelegramAuth = mod.requireTelegramAuth || requireTelegramAuth;
    isTelegramUser = mod.isTelegramUser || isTelegramUser;
} catch (e) {
    console.warn('telegramAuth middleware not found, proceeding without strict auth');
    // Lightweight local/dev fallback: derive user from x-telegram-id header
    requireTelegramAuth = (req, res, next) => {
        const telegramIdHeader = req.headers['x-telegram-id'];
        if (telegramIdHeader) {
            req.user = { id: telegramIdHeader.toString(), isAdmin: Array.isArray(adminIds) && adminIds.includes(telegramIdHeader.toString()) };
            return next();
        }
        if (process.env.NODE_ENV === 'production') {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        req.user = { id: 'dev-user', isAdmin: false };
        next();
    };
}
const reversalRequests = new Map();
// Middleware
app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (mobile apps, etc.)
        if (!origin) return callback(null, true);
        
        // Allow localhost
        const allowedPatterns = [
            /^https?:\/\/localhost(:\d+)?$/,
            /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
            /^https:\/\/.*\.vercel\.app$/,
            /^https:\/\/(www\.)?starstore\.site$/
        ];
        
        const isAllowed = allowedPatterns.some(pattern => pattern.test(origin));
        
        if (isAllowed) {
            callback(null, true);
        } else {
            console.log('CORS blocked origin:', origin);
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-telegram-init-data', 'x-telegram-id']
}));
app.use(express.json());
app.use(bodyParser.json());
app.use(express.static('public'));
app.get('/admin', (req, res) => {
	try {
		return res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html'));
	} catch (e) {
		return res.status(404).send('Not found');
	}
});
// Webhook setup (only when real bot is configured)
if (process.env.BOT_TOKEN) {
  bot.setWebHook(WEBHOOK_URL)
    .then(() => console.log(`✅ Webhook set successfully at ${WEBHOOK_URL}`))
    .catch(err => {
      console.error('❌ Webhook setup failed:', err.message);
      process.exit(1);
    });
}
// MongoDB connection (use in-memory server if no URI is provided)
async function connectDatabase() {
  if (process.env.MONGODB_URI) {
    try {
      await mongoose.connect(process.env.MONGODB_URI);
      console.log('✅ MongoDB connected successfully');
    } catch (err) {
      console.error('❌ MongoDB connection error:', err.message);
      process.exit(1);
    }
    return;
  }

  console.warn('MONGODB_URI not set. Starting in-memory MongoDB for local/dev.');
  try {
    const { MongoMemoryServer } = require('mongodb-memory-server');
    const mongod = await MongoMemoryServer.create();
    const uri = mongod.getUri();
    await mongoose.connect(uri);
    console.log('✅ In-memory MongoDB connected');
    // Expose for graceful shutdown if needed
    process.on('exit', async () => { try { await mongod.stop(); } catch (_) {} });
  } catch (err) {
    console.error('❌ Failed to start in-memory MongoDB:', err.message);
    process.exit(1);
  }
}

// Kick off database connection immediately
connectDatabase();
// Webhook handler
app.post(WEBHOOK_PATH, (req, res) => {
  if (process.env.WEBHOOK_SECRET && 
      req.headers['x-telegram-bot-api-secret-token'] !== process.env.WEBHOOK_SECRET) {
    return res.sendStatus(403);
  }
  bot.processUpdate(req.body);
  res.sendStatus(200);
});
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
    adminMessages: Array,
    // New fields for "buy for" functionality
    recipients: [{
        username: String,
        userId: String,
        starsReceived: Number,
        premiumDurationReceived: Number
    }],
    isBuyForOthers: {
        type: Boolean,
        default: false
    },
    totalRecipients: {
        type: Number,
        default: 0
    },
    starsPerRecipient: Number,
    premiumDurationPerRecipient: Number
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
    memoTag: String,
    status: {
        type: String,
        enum: ['pending', 'processing', 'completed', 'declined', 'reversed', 'refunded', 'failed', 'expired'], 
        default: 'pending'
    },
    telegram_payment_charge_id: {
        type: String,
        required: function() {
            return this.dateCreated > new Date('2025-05-25'); 
        },
        default: null
    },
    reversible: {
        type: Boolean,
        default: true
    },
    // NEW FIELDS FOR SESSION MANAGEMENT
    sessionToken: {
        type: String,
        default: null
    },
    sessionExpiry: {
        type: Date,
        default: null
    },
    userLocked: {
        type: String, 
        default: null
    },
    // END NEW FIELDS
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
    dateRefunded: Date,
    datePaid: Date, 
    dateDeclined: Date 
});

const userSchema = new mongoose.Schema({
    id: String,
    username: String
});

const bannedUserSchema = new mongoose.Schema({
    users: Array
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
    adminMessages: [{
        adminId: String,
        messageId: Number,
        originalText: String
    }],
    processedBy: { type: Number },
    processedAt: { type: Date },
    declineReason: { type: String },
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

const warningSchema = new mongoose.Schema({
    userId: { type: String, required: true },
    type: { type: String, enum: ['warning', 'ban'], required: true },
    reason: { type: String, required: true },
    issuedBy: { type: String, required: true },
    issuedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date },
    isActive: { type: Boolean, default: true },
    autoRemove: { type: Boolean, default: false }
});

// New notification template (content & targeting)
const notificationTemplateSchema = new mongoose.Schema({
    title: { type: String, required: true, default: 'Notification' },
    message: { type: String, required: true },
    actionUrl: { type: String },
    icon: { type: String, default: 'fa-bell' },
    priority: { type: Number, default: 0, min: 0, max: 2 },
    audience: { type: String, enum: ['global', 'user'], default: 'global', index: true },
    targetUserId: { type: String, index: true },
    createdBy: { type: String, default: 'system' },
    createdAt: { type: Date, default: Date.now, index: true }
});

// Per-user notification state
const userNotificationSchema = new mongoose.Schema({
    userId: { type: String, index: true, required: true },
    templateId: { type: mongoose.Schema.Types.ObjectId, ref: 'NotificationTemplate', index: true, required: true },
    read: { type: Boolean, default: false, index: true },
    createdAt: { type: Date, default: Date.now, index: true }
});

const stickerSchema = new mongoose.Schema({
  file_id: { type: String, required: true },
  file_unique_id: { type: String, required: true, unique: true },
  file_path: { type: String },
  is_animated: { type: Boolean, default: false },
  is_video: { type: Boolean, default: false },
  emoji: { type: String },
  set_name: { type: String },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now }
});

const Sticker = mongoose.model('Sticker', stickerSchema);
const NotificationTemplate = mongoose.model('NotificationTemplate', notificationTemplateSchema);
const UserNotification = mongoose.model('UserNotification', userNotificationSchema);
const Warning = mongoose.model('Warning', warningSchema);
const Reversal = mongoose.model('Reversal', reversalSchema);
const Feedback = mongoose.model('Feedback', feedbackSchema);
const ReferralTracker = mongoose.model('ReferralTracker', referralTrackerSchema);
const ReferralWithdrawal = mongoose.model('ReferralWithdrawal', referralWithdrawalSchema);
const Cache = mongoose.model('Cache', cacheSchema);
const BuyOrder = mongoose.model('BuyOrder', buyOrderSchema);
const SellOrder = mongoose.model('SellOrder', sellOrderSchema);
const User = mongoose.model('User', userSchema);
const Referral = mongoose.model('Referral', referralSchema);
const BannedUser = mongoose.model('BannedUser', bannedUserSchema);


const adminIds = (process.env.ADMIN_TELEGRAM_IDS || process.env.ADMIN_IDS || '').split(',').filter(Boolean).map(id => id.trim());
const REPLY_MAX_RECIPIENTS = parseInt(process.env.REPLY_MAX_RECIPIENTS || '30', 10);

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

// Quote endpoint for pricing (used by Buy page)
app.post('/api/quote', (req, res) => {
    try {
        const { isPremium, premiumDuration, stars, recipientsCount } = req.body || {};
        const quantity = Math.max(1, Number(recipientsCount) || 0);

        const priceMap = {
            regular: { 1000: 20, 500: 10, 100: 2, 50: 1, 25: 0.6, 15: 0.35 },
            premium: { 3: 19.31, 6: 26.25, 12: 44.79 }
        };

        if (isPremium) {
            const unitAmount = priceMap.premium[Number(premiumDuration)];
            if (!unitAmount) {
                return res.status(400).json({ success: false, error: 'Invalid premium duration' });
            }
            const totalAmount = Number((unitAmount * quantity).toFixed(2));
            return res.json({ success: true, totalAmount, unitAmount: Number(unitAmount.toFixed(2)), quantity });
        }

        const starsNum = Number(stars) || 0;
        if (!starsNum || starsNum < 50) {
            return res.status(400).json({ success: false, error: 'Invalid stars amount (min 50)' });
        }

        // For stars, charge the package price regardless of recipients (stars are distributed, not multiplied)
        const mapPrice = priceMap.regular[starsNum];
        if (typeof mapPrice === 'number') {
            // Use exact package price - total amount is the package price
            const totalAmount = Number(mapPrice.toFixed(2));
            return res.json({ 
                success: true, 
                totalAmount, 
                unitAmount: Number((totalAmount / quantity).toFixed(2)), 
                quantity 
            });
        } else {
            // Fallback to linear rate for custom amounts
            const unitAmount = Number((starsNum * 0.02).toFixed(2));
            const totalAmount = Number((unitAmount * quantity).toFixed(2));
            return res.json({ success: true, totalAmount, unitAmount, quantity });
        }
    } catch (error) {
        console.error('Quote error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Optional GET variant for environments issuing GET requests
app.get('/api/quote', (req, res) => {
    try {
        const isPremium = String(req.query.isPremium || 'false') === 'true';
        const premiumDuration = req.query.premiumDuration ? Number(req.query.premiumDuration) : undefined;
        const stars = req.query.stars ? Number(req.query.stars) : undefined;
        const recipientsCount = req.query.recipientsCount ? Number(req.query.recipientsCount) : 0;
        const quantity = Math.max(1, Number(recipientsCount) || 0);

        const priceMap = {
            regular: { 1000: 20, 500: 10, 100: 2, 50: 1, 25: 0.6, 15: 0.35 },
            premium: { 3: 19.31, 6: 26.25, 12: 44.79 }
        };

        if (isPremium) {
            const unitAmount = priceMap.premium[Number(premiumDuration)];
            if (!unitAmount) {
                return res.status(400).json({ success: false, error: 'Invalid premium duration' });
            }
            const totalAmount = Number((unitAmount * quantity).toFixed(2));
            return res.json({ success: true, totalAmount, unitAmount: Number(unitAmount.toFixed(2)), quantity });
        }

        const starsNum = Number(stars) || 0;
        if (!starsNum || starsNum < 50) {
            return res.status(400).json({ success: false, error: 'Invalid stars amount (min 50)' });
        }

        // For stars, charge the package price regardless of recipients (stars are distributed, not multiplied)
        const mapPrice = priceMap.regular[starsNum];
        if (typeof mapPrice === 'number') {
            // Use exact package price - total amount is the package price
            const totalAmount = Number(mapPrice.toFixed(2));
            return res.json({ 
                success: true, 
                totalAmount, 
                unitAmount: Number((totalAmount / quantity).toFixed(2)), 
                quantity 
            });
        } else {
            // Fallback to linear rate for custom amounts
            const unitAmount = Number((starsNum * 0.02).toFixed(2));
            const totalAmount = Number((unitAmount * quantity).toFixed(2));
            return res.json({ success: true, totalAmount, unitAmount, quantity });
        }
    } catch (error) {
        console.error('Quote (GET) error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Username validation endpoint (format validation only)
// Note: Telegram Bot API cannot validate usernames without user interaction due to privacy restrictions
app.post('/api/validate-usernames', (req, res) => {
    try {
        const usernames = Array.isArray(req.body?.usernames) ? req.body.usernames : [];
        console.log('Username validation request:', { usernames });
        
        const recipients = [];
        const seen = new Set();
        
        for (const raw of usernames) {
            if (typeof raw !== 'string') {
                console.log('Skipping non-string username:', raw);
                continue;
            }
            
            const name = raw.trim().replace(/^@/, '').toLowerCase();
            console.log('Processing username:', { raw, trimmed: name });
            
            // Format validation: 1-32 chars, letters, digits, underscore
            // This is the best we can do without user interaction due to Telegram privacy restrictions
            const isValid = /^[a-z0-9_]{1,32}$/.test(name);
            if (!isValid) {
                console.log('Username failed format validation:', name);
                continue;
            }
            
            if (seen.has(name)) {
                console.log('Duplicate username:', name);
                continue;
            }
            
            seen.add(name);
            // Generate stable pseudo userId from hash (since we can't get real Telegram IDs)
            const hash = crypto.createHash('md5').update(name).digest('hex').slice(0, 10);
            const userId = parseInt(hash, 16).toString().slice(0, 10);
            recipients.push({ username: name, userId });
            console.log('Added valid recipient:', { username: name, userId });
        }
        
        console.log('Validation result:', { totalRequested: usernames.length, validRecipients: recipients.length });
        return res.json({ success: true, recipients });
    } catch (error) {
        console.error('validate-usernames error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

app.post('/api/orders/create', async (req, res) => {
    try {
        const { telegramId, username, stars, walletAddress, isPremium, premiumDuration, recipients, transactionHash, isTelegramUser, totalAmount } = req.body;

        if (!telegramId || !username || !walletAddress || (isPremium && !premiumDuration)) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const bannedUser = await BannedUser.findOne({ users: telegramId.toString() });
        if (bannedUser) {
            return res.status(403).json({ error: 'You are banned from placing orders' });
        }

        // Handle recipients for "buy for others" functionality
        let isBuyForOthers = false;
        let totalRecipients = 0;
        let starsPerRecipient = null;
        let premiumDurationPerRecipient = null;
        let processedRecipients = [];
        
        console.log('Order creation - received data:', {
            stars,
            isPremium,
            premiumDuration,
            recipients: recipients?.length || 0,
            totalAmount
        });

        if (recipients && Array.isArray(recipients) && recipients.length > 0) {
            isBuyForOthers = true;
            totalRecipients = recipients.length;
            
            if (isPremium) {
                // For premium, duration is shared equally
                premiumDurationPerRecipient = premiumDuration;
            } else {
                // For stars, distribute equally
                starsPerRecipient = Math.floor(stars / totalRecipients);
                const remainingStars = stars % totalRecipients;
                
                // Process recipients with equal distribution
                processedRecipients = recipients.map((recipient, index) => ({
                    username: recipient,
                    userId: null, // Will be filled when order is completed
                    starsReceived: starsPerRecipient + (index < remainingStars ? 1 : 0),
                    premiumDurationReceived: null
                }));
            }
        }

        // Use totalAmount from frontend if provided (for accurate multi-recipient pricing)
        let amount, packageType;
        if (totalAmount && typeof totalAmount === 'number' && totalAmount > 0) {
            // Use the accurate total amount from frontend quote
            amount = totalAmount;
            packageType = isPremium ? 'premium' : 'regular';
        } else {
            // Fallback to old pricing logic for backward compatibility
            const priceMap = {
                regular: { 1000: 20, 500: 10, 100: 2, 50: 1, 25: 0.6, 15: 0.35 },
                premium: { 3: 19.31, 6: 26.25, 12: 44.79 }
            };

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
        }

        const order = new BuyOrder({
            id: generateOrderId(),
            telegramId,
            username,
            amount,
            stars: isPremium ? null : stars,
            premiumDuration: isPremium ? null : premiumDuration,
            walletAddress,
            isPremium,
            status: 'pending',
            dateCreated: new Date(),
            adminMessages: [],
            recipients: processedRecipients,
            isBuyForOthers,
            totalRecipients,
            starsPerRecipient,
            premiumDurationPerRecipient
        });

        await order.save();
        
        console.log('Final order details:', {
            orderId: order.id,
            amount: amount,
            isBuyForOthers,
            totalRecipients,
            starsPerRecipient
        });

        // Create user message based on order type
        let userMessage = `🎉 Order received!\n\nOrder ID: ${order.id}\nAmount: ${amount} USDT\nStatus: Pending`;
        
        if (isPremium) {
            userMessage = `🎉 Premium order received!\n\nOrder ID: ${order.id}\nAmount: ${amount} USDT\nDuration: ${premiumDuration} months\nStatus: Pending`;
            if (isBuyForOthers) {
                userMessage += `\n\nRecipients: ${totalRecipients} user(s)`;
            }
        } else {
            userMessage = `🎉 Order received!\n\nOrder ID: ${order.id}\nAmount: ${amount} USDT\nStars: ${stars}\nStatus: Pending`;
            if (isBuyForOthers) {
                userMessage += `\n\nRecipients: ${totalRecipients} user(s)\nStars per recipient: ${starsPerRecipient}`;
            }
        }

        await bot.sendMessage(telegramId, userMessage);

        // Create enhanced admin message
        let adminMessage = `🛒 New ${isPremium ? 'Premium' : 'Buy'} Order!\n\nOrder ID: ${order.id}\nUser: @${username}\nAmount: ${amount} USDT`;
        
        if (isPremium) {
            adminMessage += `\nDuration: ${premiumDuration} months`;
        } else {
            adminMessage += `\nStars: ${stars}`;
        }
        
        if (isBuyForOthers) {
            adminMessage += `\n\n🎯 Buy For Others: ${totalRecipients} recipient(s)`;
            if (isPremium) {
                adminMessage += `\nDuration per recipient: ${premiumDurationPerRecipient} months`;
            } else {
                adminMessage += `\nStars per recipient: ${starsPerRecipient}`;
            }
            adminMessage += `\n\nRecipients: ${recipients.map(r => `@${r}`).join(', ')}`;
        }

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

function sanitizeUsername(username) {
    if (!username) return null;
    return username.replace(/[^\w\d_]/g, '');
}

app.post("/api/sell-orders", async (req, res) => {
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

        const paymentLink = await createTelegramInvoice(
            telegramId, 
            order.id, 
            stars, 
            `Purchase of ${stars} Telegram Stars`,
            sessionToken 
        );
        
        if (!paymentLink) {
            return res.status(500).json({ error: "Failed to generate payment link" });
        }

        await order.save();

        const userMessage = `🚀 Sell order initialized!\n\nOrder ID: ${order.id}\nStars: ${order.stars}\nStatus: Pending (Waiting for payment)\n\n⏰ Payment link expires in 15 minutes\n\nPay here: ${paymentLink}`;
        await bot.sendMessage(telegramId, userMessage);

        res.json({ 
            success: true, 
            order, 
            paymentLink,
            expiresAt: sessionExpiry
        });
    } catch (err) {
        console.error("Sell order creation error:", err);
        res.status(500).json({ error: "Failed to create sell order" });
    }
});

// Generate unique session token
function generateSessionToken(telegramId) {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 15);
    return `${telegramId}_${timestamp}_${random}`;
}

// Enhanced pre-checkout validation 
bot.on('pre_checkout_query', async (query) => {
    const orderId = query.invoice_payload;
    const order = await SellOrder.findOne({ id: orderId }) || await BuyOrder.findOne({ id: orderId });
    
    if (!order) {
        await bot.answerPreCheckoutQuery(query.id, false, { error_message: "Order not found" });
        return;
    }

    // Check if order has expired
    if (order.sessionExpiry && new Date() > order.sessionExpiry) {
        await bot.answerPreCheckoutQuery(query.id, false, { error_message: "Payment session has expired" });
        // Update order status to expired
        order.status = "expired";
        await order.save();
        return;
    }

    // Check if the user making payment matches the order creator
    if (order.userLocked && order.userLocked.toString() !== query.from.id.toString()) {
        await bot.answerPreCheckoutQuery(query.id, false, { error_message: "This payment link is not valid for your account" });
        return;
    }

    // Check if order already processed (duplicate payment protection)
    if (order.status !== "pending") {
        await bot.answerPreCheckoutQuery(query.id, false, { error_message: "Order already processed" });
        return;
    }

    await bot.answerPreCheckoutQuery(query.id, true);
});

async function getUserDisplayName(telegramId) {
    try {
        const chat = await bot.getChat(telegramId);
        
        let displayName = '';
        
        if (chat.first_name) {
            displayName = chat.first_name;
            if (chat.last_name) {
                displayName += ` ${chat.last_name}`;
            }
        } else {
            displayName = `User ${telegramId}`;
        }
        
        return displayName;
    } catch (error) {
        console.error(`Failed to get user info for ${telegramId}:`, error);
        return `User ${telegramId}`;
    }
}

bot.on("successful_payment", async (msg) => {
    const orderId = msg.successful_payment.invoice_payload;
    const order = await SellOrder.findOne({ id: orderId });

    if (!order) {
        return await bot.sendMessage(msg.chat.id, "❌ Payment was successful, but the order was not found. Please contact support.");
    }

    // Verify user matches order creator
    if (order.userLocked && order.userLocked.toString() !== msg.from.id.toString()) {
        // This shouldn't happen if pre-checkout validation works, but extra safety
        await bot.sendMessage(msg.chat.id, "❌ Payment validation error. Please contact support.");
        return;
    }

    // Check if order already processed (duplicate payment protection)
    if (order.status !== "pending") {
        await bot.sendMessage(msg.chat.id, "❌ This order has already been processed. If you were charged multiple times, please contact support.");
        return;
    }

    order.telegram_payment_charge_id = msg.successful_payment.telegram_payment_charge_id;
    order.status = "processing"; 
    order.datePaid = new Date();
    order.sessionToken = null; 
    order.sessionExpiry = null; 
    await order.save();

    await bot.sendMessage(
        order.telegramId,
        `✅ Payment successful!\n\n` +
        `Order ID: ${order.id}\n` +
        `Stars: ${order.stars}\n` +
        `Wallet: ${order.walletAddress}\n` +
        `${order.memoTag ? `Memo: ${order.memoTag}\n` : ''}` +
        `\nStatus: Processing (21-day hold)\n\n` +
        `Funds will be released to your wallet after the hold period.`
    );
  
    const userDisplayName = await getUserDisplayName(order.telegramId);
    
    const adminMessage = `💰 New Payment Received!\n\n` +
        `Order ID: ${order.id}\n` +
        `User: ${order.username ? `@${order.username}` : userDisplayName} (ID: ${order.telegramId})\n` + 
        `Stars: ${order.stars}\n` +
        `Wallet: ${order.walletAddress}\n` +  
        `Memo: ${order.memoTag || 'None'}`;

    const adminKeyboard = {
        inline_keyboard: [
            [
                { text: "✅ Complete", callback_data: `complete_sell_${order.id}` },
                { text: "❌ Fail", callback_data: `decline_sell_${order.id}` },
                { text: "💸 Refund", callback_data: `refund_sell_${order.id}` }
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
        const adminUsername = query.from.username ? query.from.username : `User_${query.from.id}`;

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

            if (!order.telegram_payment_charge_id && order.dateCreated > new Date('2025-05-25')) {
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

            order.status = 'failed';
            order.dateDeclined = new Date();
            await order.save();
        }
        else if (data.startsWith('refund_sell_')) {
            actionType = 'refund';
            orderType = 'sell';
            order = await SellOrder.findOne({ id: data.split('_')[2] });

            if (!order) {
                await bot.answerCallbackQuery(query.id, { text: "Sell order not found" });
                return;
            }

            order.status = 'refunded';
            order.dateRefunded = new Date();
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
            
            // Handle recipient notifications for "buy for others" orders
            if (order.isBuyForOthers && order.recipients && order.recipients.length > 0) {
                try {
                    // Send notifications to all recipients
                    for (const recipient of order.recipients) {
                        try {
                            let recipientMessage = `🎁 You received a gift from @${order.username}!\n\n`;
                            
                            if (order.isPremium) {
                                recipientMessage += `🎉 Premium Subscription: ${order.premiumDurationPerRecipient} months\n`;
                                recipientMessage += `Order ID: ${order.id}\n`;
                                recipientMessage += `Status: Confirmed`;
                            } else {
                                recipientMessage += `⭐ Stars: ${recipient.starsReceived}\n`;
                                recipientMessage += `Order ID: ${order.id}\n`;
                                recipientMessage += `Status: Confirmed`;
                            }
                            
                            // Try to send message to recipient (they might not be in the bot)
                            // This will fail silently if user hasn't started the bot
                            try {
                                // You might want to implement a way to get recipient's telegram ID
                                // For now, we'll just log the attempt
                                console.log(`Attempting to notify recipient: @${recipient.username}`);
                            } catch (recipientErr) {
                                console.log(`Could not notify recipient @${recipient.username}:`, recipientErr.message);
                            }
                        } catch (recipientErr) {
                            console.error(`Error processing recipient ${recipient.username}:`, recipientErr);
                        }
                    }
                    
                    // Create notifications in the database for recipients
                    for (const recipient of order.recipients) {
                        try {
                            await Notification.create({
                                userId: recipient.userId || 'anonymous',
                                title: 'Gift Received! 🎁',
                                message: `You received ${order.isPremium ? `${order.premiumDurationPerRecipient} months Premium` : `${recipient.starsReceived} Stars`} from @${order.username}!`,
                                icon: 'gift',
                                priority: 1,
                                isGlobal: false
                            });
                        } catch (notifErr) {
                            console.error(`Failed to create notification for ${recipient.username}:`, notifErr);
                        }
                    }
                } catch (recipientErr) {
                    console.error('Error handling recipient notifications:', recipientErr);
                }
            }
            
            // Track stars/premium for the buyer
            if (!order.isPremium && order.stars) {
                await trackStars(order.telegramId, order.stars, 'buy');
            }
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

        const statusText = order.status === 'completed' ? '✅ Completed' : 
                          order.status === 'failed' ? '❌ Failed' : 
                          order.status === 'refunded' ? '💸 Refunded' : '❌ Declined';
        const processedBy = `Processed by: @${adminUsername}`;
        const completionNote = orderType === 'sell' && order.status === 'completed' ? '\n\nPayments have been transferred to the seller.' : '';

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
            ? `✅ Your ${orderType} order #${order.id} has been confirmed!${orderType === 'sell' ? '\n\nPayment has been sent to your wallet.' : '\n\nThank you for your choosing StarStore!'}`
            : order.status === 'failed'
            ? `❌ Your sell order #${order.id} has failed.\n\nPlease try selling a lower amount or contact support if the issue persist.`
            : order.status === 'refunded'
            ? `💸 Your sell order #${order.id} has been refunded.\n\nPlease check your Account for the refund.`
            : `❌ Your buy order #${order.id} has been declined.\n\nPlease contact support if you believe this was a mistake.`;

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

async function createTelegramInvoice(chatId, orderId, stars, description, sessionToken) {
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
            ],
            start_parameter: sessionToken?.substring(0, 64) 
        });
        return response.data.result;
    } catch (error) {
        console.error('Error creating invoice:', error);
        throw error;
    }
}

// Background job to clean up expired orders - ENHANCED WITH USER NOTIFICATIONS
async function cleanupExpiredOrders() {
    try {
        // Find expired orders first to notify users
        const expiredOrders = await SellOrder.find({
            status: "pending",
            sessionExpiry: { $lt: new Date() }
        });

        // Notify users about expired orders
        for (const order of expiredOrders) {
            try {
                await bot.sendMessage(
                    order.telegramId,
                    `⏰ Your sell order #${order.id} has expired.\n\n` +
                    `Stars: ${order.stars}\n` +
                    `You can create a new order if you still want to sell.`
                );
            } catch (err) {
                console.error(`Failed to notify user ${order.telegramId} about expired order:`, err);
            }
        }

        // Update expired orders in database
        const updateResult = await SellOrder.updateMany(
            { 
                status: "pending",
                sessionExpiry: { $lt: new Date() }
            },
            { 
                status: "expired",
                $unset: { sessionToken: 1, sessionExpiry: 1 }
            }
        );
        
        if (updateResult.modifiedCount > 0) {
            // Send notification to admin channel or first admin instead of console
            if (adminIds && adminIds.length > 0) {
                try {
                    await bot.sendMessage(
                        adminIds[0], 
                        `🧹 System Cleanup:\n\n` +
                        `Cleaned up ${updateResult.modifiedCount} expired sell orders\n` +
                        `Time: ${new Date().toLocaleString()}`
                    );
                } catch (err) {
                    console.error('Failed to notify admin about cleanup:', err);
                    // Fallback to console if admin notification fails
                    console.log(`Cleaned up ${updateResult.modifiedCount} expired sell orders`);
                }
            } else {
                console.log(`Cleaned up ${updateResult.modifiedCount} expired sell orders`);
            }
        }
    } catch (error) {
        console.error('Error cleaning up expired orders:', error);
        // Notify admin about cleanup errors
        if (adminIds && adminIds.length > 0) {
            try {
                await bot.sendMessage(
                    adminIds[0],
                    `❌ Cleanup Error:\n\n` +
                    `Failed to clean up expired orders\n` +
                    `Error: ${error.message}\n` +
                    `Time: ${new Date().toLocaleString()}`
                );
            } catch (err) {
                console.error('Failed to notify admin about cleanup error:', err);
            }
        }
    }
}

// Run cleanup every 5 minutes
setInterval(cleanupExpiredOrders, 5 * 60 * 1000);


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

// STICKER HANDLER
bot.on('sticker', async (msg) => {
  try {
    const sticker = msg.sticker;
    if (!sticker) return;

    console.log('Processing sticker:', {
      id: sticker.file_unique_id,
      set: sticker.set_name,
      type: sticker.is_animated ? 'animated' : sticker.is_video ? 'video' : 'static'
    });

    const fileInfo = await bot.getFile(sticker.file_id);
    if (!fileInfo.file_path) return;

    const updateData = {
      file_id: sticker.file_id,
      file_path: fileInfo.file_path,
      is_animated: sticker.is_animated || false,
      is_video: sticker.is_video || false,
      emoji: sticker.emoji || '',
      set_name: sticker.set_name || '',
      updated_at: new Date()
    };

    await Sticker.updateOne(
      { file_unique_id: sticker.file_unique_id },
      { $set: updateData, $setOnInsert: { created_at: new Date() } },
      { upsert: true }
    );

  } catch (error) {
    console.error('Sticker processing error:', error.message);
  }
});

// API ENDPOINTS
app.get('/api/sticker/:sticker_id/json', async (req, res) => {
  try {
    const sticker = await Sticker.findOne({ file_unique_id: req.params.sticker_id });
    if (!sticker || !sticker.file_path.endsWith('.tgs')) {
      return res.status(404).json({ error: 'Sticker not found or not animated' });
    }

    const telegramUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${sticker.file_path}`;
    const tgRes = await fetch(telegramUrl);
    const buffer = await tgRes.arrayBuffer();

    zlib.unzip(Buffer.from(buffer), (err, jsonBuffer) => {
      if (err) {
        console.error('Decompression error:', err);
        return res.status(500).json({ error: 'Failed to decode sticker' });
      }

      try {
        const json = JSON.parse(jsonBuffer.toString());
        res.json(json);
      } catch (e) {
        res.status(500).json({ error: 'Invalid JSON' });
      }
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal error' });
  }
});

app.get('/api/sticker/:id/info', async (req, res) => {
  try {
    const sticker = await Sticker.findOne(
      { file_unique_id: req.params.id },
      { _id: 0, file_unique_id: 1, is_animated: 1, is_video: 1, emoji: 1, set_name: 1 }
    );
    
    if (!sticker) {
      return res.status(404).json({ error: 'Sticker not found' });
    }
    
    res.json(sticker);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/stickers', async (req, res) => {
  try {
    const { set, limit = 50, offset = 0 } = req.query;
    const query = set ? { set_name: set } : {};
    
    const stickers = await Sticker.find(query, {
      file_unique_id: 1,
      emoji: 1,
      set_name: 1,
      is_animated: 1,
      is_video: 1
    })
    .sort({ created_at: -1 })
    .skip(parseInt(offset))
    .limit(parseInt(limit));
    
    res.json(stickers);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

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
// Authentication middleware for referral endpoints
function validateTelegramUser(req, res, next) {
    const userId = req.params.userId;
    const telegramId = req.headers['x-telegram-id'];
    
    console.log(`Validating access for userId: ${userId}, telegramId: ${telegramId}`);
    
    if (!telegramId || telegramId !== userId) {
        console.log(`Unauthorized access attempt: userId=${userId}, telegramId=${telegramId}`);
        return res.status(403).json({ 
            success: false, 
            error: 'Unauthorized access to referral data' 
        });
    }
    next();
}

app.get('/api/referral-stats/:userId', validateTelegramUser, async (req, res) => {
    try {
        const userId = req.params.userId;
        console.log(`Fetching referral data for user: ${userId}`);
        
        // Check if user exists
        const user = await User.findOne({ id: userId });
        if (!user) {
            console.log(`User not found: ${userId}`);
            return res.status(404).json({ 
                success: false, 
                error: 'User not found' 
            });
        }
        
        const referrals = await Referral.find({ referrerUserId: userId });
        console.log(`Found ${referrals.length} referrals for user ${userId}`);
        
        const referredUserIds = referrals.map(r => r.referredUserId);
        const users = await User.find({ id: { $in: referredUserIds } });
        
        const userMap = {};
        users.forEach(user => userMap[user.id] = user.username);

        const totalReferrals = referrals.length;
        
        // Get completed/active AND non-withdrawn referrals
        const availableReferrals = await Referral.find({
            referrerUserId: req.params.userId,
            status: { $in: ['completed', 'active'] },
            withdrawn: { $ne: true }
        }).countDocuments();

        // Get all completed/active (regardless of withdrawal status)
        const completedReferrals = referrals.filter(r => 
            ['completed', 'active'].includes(r.status)
        ).length;
        
        console.log(`Referral stats for user ${req.params.userId}:`, {
            totalReferrals,
            completedReferrals,
            availableReferrals,
            referrals: referrals.map(r => ({ status: r.status, withdrawn: r.withdrawn }))
        });

        const responseData = {
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
                pendingAmount: (completedReferrals - availableReferrals) * 0.5
            },
            referralLink: `https://t.me/TgStarStore_bot?start=ref_${req.params.userId}`
        };
        
        console.log(`Returning referral stats for ${req.params.userId}:`, responseData.stats);
        res.json(responseData);
        
    } catch (error) {
        console.error('Referral stats error:', error);
        res.status(500).json({ 
            success: false,
            error: 'Failed to load referral data' 
        });
    }
});
//get history for referrals withdraw for referral page

app.get('/api/withdrawal-history/:userId', validateTelegramUser, async (req, res) => {
    try {
        const { userId } = req.params;
        console.log(`Fetching withdrawal history for user: ${userId}`);
        
        // Check if user exists
        const user = await User.findOne({ id: userId });
        if (!user) {
            console.log(`User not found for withdrawal history: ${userId}`);
            return res.status(404).json({ 
                success: false, 
                error: 'User not found' 
            });
        }
        
        const withdrawals = await ReferralWithdrawal.find({ userId })
            .sort({ createdAt: -1 })
            .limit(50);

        console.log(`Found ${withdrawals.length} withdrawals for user ${userId}`);
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

        const userMessage = `✅ Withdrawal Request Submitted\n\n` +
                          `💵 Amount: ${amountNum} USDT\n` +
                          `👛 Wallet: ${walletAddress}\n` +
                          `🆔 ID: WD${withdrawal._id.toString().slice(-8).toUpperCase()}\n\n` +
                          `⏳ Status: Pending approval`;

        await bot.sendMessage(userId, userMessage);

        const adminMessage = `💸 Withdrawal Request\n\n` +
                           `👤 User: @${username} (ID: ${userId})\n` +
                           `💵 Amount: ${amountNum} USDT\n` +
                           `👛 Wallet: ${walletAddress}\n` +
                           `👥 Referrals: ${referralsNeeded}\n` +
                           `🆔 WDID: WD${withdrawal._id.toString().slice(-8).toUpperCase()}`;

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
        const { data, from } = query;
        
        if (!adminIds.includes(from.id.toString())) {
            await bot.answerCallbackQuery(query.id, { text: "⛔ Unauthorized action" });
            return;
        }

        if (!data.includes('withdrawal_')) {
            return;
        }

        // Support decline reason selection flow
        let action = data.startsWith('complete_withdrawal_') ? 'complete'
                    : data.startsWith('decline_withdrawal_') ? 'decline'
                    : data.startsWith('decline_reason_') ? 'decline_reason'
                    : 'unknown';
        const parts = data.split('_');
        const withdrawalId = parts[parts.length - 1];

        if (!withdrawalId) {
            await bot.answerCallbackQuery(query.id, { text: "❌ Invalid withdrawal ID" });
            return;
        }

        // If decline selected, show reason selector and return without processing DB yet
        if (action === 'decline') {
            const reasonKeyboard = {
                inline_keyboard: [[
                    { text: 'Wrong wallet address', callback_data: `decline_reason_wrongwallet_${withdrawalId}` }
                ],[
                    { text: 'Not approved', callback_data: `decline_reason_notapproved_${withdrawalId}` }
                ],[
                    { text: 'Other', callback_data: `decline_reason_other_${withdrawalId}` }
                ]]
            };

            try {
                await bot.editMessageReplyMarkup(reasonKeyboard, { chat_id: query.message.chat.id, message_id: query.message.message_id });
            } catch (editErr) {
                // Fallback: send a separate message for reason selection
                await bot.sendMessage(query.message.chat.id, 'Select decline reason:', { reply_markup: reasonKeyboard });
            }
            await bot.answerCallbackQuery(query.id, { text: 'Choose a reason' });
            return; // stop here until a reason is chosen
        }

        if (action === 'decline_reason') {
            // Map reason code to human text
            const reasonCode = parts[2]; // decline, reason, <code>, <id>
            const reasonMap = {
                wrongwallet: 'Wrong wallet address',
                notapproved: 'Not approved',
                other: 'Other'
            };
            const declineReason = reasonMap[reasonCode] || 'Declined';
            await bot.answerCallbackQuery(query.id, { text: `⏳ Processing decline...` });

            // Proceed with decline in DB below using declineReason
            action = 'decline_final';
            query.declineReason = declineReason;
        } else {
            await bot.answerCallbackQuery(query.id, { text: `⏳ Processing ${action}...` });
        }

        const withdrawal = await ReferralWithdrawal.findOneAndUpdate(
            { _id: new mongoose.Types.ObjectId(withdrawalId), status: 'pending' },
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
            await session.abortTransaction();
            return;
        }

        const finalDecline = action === 'decline' || action === 'decline_final';
        if (finalDecline) {
            await Referral.updateMany(
                { _id: { $in: withdrawal.referralIds } },
                { $set: { withdrawn: false } },
                { session }
            );
        }

        const declineReasonText = query.declineReason ? `\nReason: ${query.declineReason}` : '';
        const userMessage = action === 'complete'
            ? `✅ Withdrawal WD${withdrawal._id.toString().slice(-8).toUpperCase()} Completed!\n\n` +
              `Amount: ${withdrawal.amount} USDT\n` +
              `Wallet: ${withdrawal.walletAddress}\n\n` +
              `Funds have been sent to your wallet.`
            : `❌ Withdrawal WD${withdrawal._id.toString().slice(-8).toUpperCase()} Declined${declineReasonText}\n\n` +
              `Amount: ${withdrawal.amount} USDT\n` +
              `Contact support for more information.`;

        await bot.sendMessage(withdrawal.userId, userMessage);

        const statusText = action === 'complete' ? '✅ Completed' : '❌ Declined';
        const processedBy = `Processed by: @${from.username || `admin_${from.id.toString().slice(-4)}`}`;

        // Ensure adminMessages contains at least the clicking admin's message
        const clickedChatId = query.message?.chat?.id?.toString();
        const clickedMessageId = query.message?.message_id;
        const clickedOriginalText = query.message?.text || '';

        if (!Array.isArray(withdrawal.adminMessages)) {
            withdrawal.adminMessages = [];
        }

        const hasClickedInList = withdrawal.adminMessages.some(m => m && m.adminId?.toString() === clickedChatId && m.messageId === clickedMessageId);
        if (!hasClickedInList && clickedChatId && clickedMessageId) {
            withdrawal.adminMessages.push({ adminId: clickedChatId, messageId: clickedMessageId, originalText: clickedOriginalText });
            try {
                await ReferralWithdrawal.updateOne(
                    { _id: withdrawal._id },
                    { $set: { adminMessages: withdrawal.adminMessages } },
                    { session }
                );
            } catch (saveAdminMsgsErr) {
                console.warn('Could not persist adminMessages for withdrawal:', saveAdminMsgsErr.message);
            }
        }

        const updateSingleMessage = async (adminMsg) => {
            if (!adminMsg?.adminId || !adminMsg?.messageId) return;
            const baseText = adminMsg.originalText || clickedOriginalText || '';
            const updatedText = `${baseText}\n\n` +
                                `Status: ${statusText}\n` +
                                (query.declineReason ? `Reason: ${query.declineReason}\n` : '') +
                                `${processedBy}\n` +
                                `Processed at: ${new Date().toLocaleString()}`;
            try {
                await bot.editMessageText(updatedText, {
                    chat_id: parseInt(adminMsg.adminId, 10) || adminMsg.adminId,
                    message_id: adminMsg.messageId,
                    reply_markup: {
                        inline_keyboard: [[
                            { text: statusText, callback_data: `processed_withdrawal_${withdrawal._id}_${Date.now()}` }
                        ]]
                    }
                });
            } catch (err) {
                // Fallback: try editing only reply markup
                try {
                    await bot.editMessageReplyMarkup(
                        { inline_keyboard: [[{ text: statusText, callback_data: `processed_withdrawal_${withdrawal._id}_${Date.now()}` }]] },
                        { chat_id: parseInt(adminMsg.adminId, 10) || adminMsg.adminId, message_id: adminMsg.messageId }
                    );
                } catch (fallbackErr) {
                    console.error(`Failed to update admin ${adminMsg.adminId}:`, fallbackErr.message);
                }
            }
        };

        // Always update the clicked admin's message first for immediate feedback
        if (clickedChatId && clickedMessageId) {
            await updateSingleMessage({ adminId: clickedChatId, messageId: clickedMessageId, originalText: clickedOriginalText });
        }

        // Then update all stored admin messages (skip the one we already updated)
        if (withdrawal.adminMessages?.length) {
            await Promise.all(withdrawal.adminMessages
                .filter(m => !(m.adminId?.toString() === clickedChatId && m.messageId === clickedMessageId))
                .map(updateSingleMessage)
            );
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
        } else if (error.message.includes("Cast to ObjectId failed")) {
            errorMsg = "❌ Invalid withdrawal ID";
        }
        
        await bot.answerCallbackQuery(query.id, { text: errorMsg });
    } finally {
        session.endSession();
    }
});



//referral tracking for referrals rewards
async function handleReferralActivation(tracker) {
    try {
        // Get user details
        const [referrer, referred] = await Promise.all([
            User.findOne({ id: tracker.referrerUserId }),
            User.findOne({ id: tracker.referredUserId })
        ]);

        // Update both tracker and referral
        tracker.status = 'active';
        tracker.dateActivated = new Date();
        await tracker.save();

        if (tracker.referral) {
            await Referral.findByIdAndUpdate(tracker.referral, {
                status: 'completed',
                dateActivated: new Date()
            });
        }

        // Format detailed admin notification
        const adminMessage = `🎉 REFERRAL ACTIVATED!\n\n` +
            `🔗 Referral Link: ${tracker.referral}\n` +
            `👤 Referrer: @${referrer?.username || 'unknown'} (ID: ${tracker.referrerUserId})\n` +
            `👥 Referred: @${referred?.username || tracker.referredUsername || 'unknown'} (ID: ${tracker.referredUserId})\n` +
            `⭐ Total Stars Bought: ${tracker.totalBoughtStars}\n` +
            `⭐ Total Stars Sold: ${tracker.totalSoldStars}\n` +
            `🎖️ Premium Activated: ${tracker.premiumActivated ? 'Yes' : 'No'}\n` +
            `📅 Date Referred: ${tracker.dateReferred.toLocaleDateString()}\n` +
            `📅 Date Activated: ${new Date().toLocaleDateString()}`;

        // Send to all admins
        for (const adminId of adminIds) {
            try {
                await bot.sendMessage(adminId, adminMessage, {
                    parse_mode: 'Markdown',
                    disable_web_page_preview: true
                });
            } catch (err) {
                console.error(`Failed to notify admin ${adminId}:`, err);
            }
        }

        // Send notification to referrer
        await bot.sendMessage(
            tracker.referrerUserId,
            `🎉 Your referral @${referred?.username || tracker.referredUsername} just became active!\n` +
            `You earned 0.5 USDT referral bonus.`
        );
    } catch (error) {
        console.error('Referral activation error:', error);
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
            await handleReferralActivation(tracker);
        } else {
            await tracker.save();
        }
        
        // Also update the Referral status if it's still pending and conditions are met
        if (tracker.referral && (totalStars >= 100 || tracker.premiumActivated)) {
            const referral = await Referral.findById(tracker.referral);
            if (referral && referral.status === 'pending') {
                referral.status = 'completed';
                referral.dateActivated = new Date();
                await referral.save();
            }
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
            
            // Also update the Referral status if it's still pending
            if (tracker.referral) {
                const referral = await Referral.findById(tracker.referral);
                if (referral && referral.status === 'pending') {
                    referral.status = 'completed';
                    referral.dateActivated = new Date();
                    await referral.save();
                }
            }
        }
    } catch (error) {
        console.error('Premium activation error:', error);
    }
}


//end of referral track 

//ban system 
bot.onText(/\/ban(?:\s+(\d+))$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const requesterId = msg.from.id.toString();
    
    if (!adminIds.includes(requesterId)) {
        return bot.sendMessage(chatId, '⛔ **Access Denied**\n\nInsufficient privileges to execute this command.', {
            parse_mode: 'Markdown',
            reply_to_message_id: msg.message_id
        });
    }
    
    if (!match[1]) return;
    
    const userId = match[1];
    const existing = await Warning.findOne({ userId: userId, type: 'ban', isActive: true });
    if (existing) {
        return bot.sendMessage(chatId, `⚠️ User ${userId} is already banned.`, {
            reply_to_message_id: msg.message_id
        });
    }
    
    await Warning.create({
        userId: userId,
        type: 'ban',
        reason: 'Policy violation',
        issuedBy: requesterId,
        isActive: true,
        autoRemove: false
    });
    
    await BannedUser.updateOne(
        {}, 
        { $push: { users: userId } },
        { upsert: true }
    );
    
    try {
        const userSuspensionNotice = `**ACCOUNT NOTICE**\n\n` +
            `We've detected unusual account activities that violate our terms of service.\n\n` +
            `**Account Status**: Temporarily Restricted\n` +
            `**Effective Date**: ${new Date().toLocaleDateString()}\n\n` +
            `During this time, you will not be able to place orders until the restriction period ends.\n\n` +
            `If you believe this is an error, please contact our support team.`;
        
        await bot.sendMessage(userId, userSuspensionNotice, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error('Suspension notification delivery failed:', error);
    }
    
    const adminSummary = `✅ **Account Ban Applied**\n\n` +
        `**Target Account**: ${userId}\n` +
        `**Suspension Type**: Indefinite\n` +
        `**Reason**: Rule violation\n` +
        `**Authorized By**: ${msg.from.username ? `@${msg.from.username}` : msg.from.first_name}\n` +
        `**Timestamp**: ${new Date().toLocaleString()}`;
    
    await bot.sendMessage(chatId, adminSummary, {
        parse_mode: 'Markdown',
        reply_to_message_id: msg.message_id
    });
});

bot.onText(/\/warn(?:\s+(\d+))$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const requesterId = msg.from.id.toString();
    
    if (!adminIds.includes(requesterId)) {
        return bot.sendMessage(chatId, '⛔ **Access Denied**\n\nInsufficient privileges to execute this command.', {
            parse_mode: 'Markdown',
            reply_to_message_id: msg.message_id
        });
    }
    
    if (!match[1]) return;
    
    const userId = match[1];
    
    const expirationDate = new Date();
    expirationDate.setDate(expirationDate.getDate() + 2);
    
    await Warning.create({
        userId: userId,
        type: 'warning',
        reason: 'Minor policy violation',
        issuedBy: requesterId,
        expiresAt: expirationDate,
        isActive: true,
        autoRemove: true
    });
    
    await BannedUser.updateOne(
        {}, 
        { $push: { users: userId } },
        { upsert: true }
    );
    
    try {
        const userWarningNotice = `**ACCOUNT NOTICE**\n\n` +
            `We've detected unusual account activities that require attention.\n\n` +
            `**Account Status**: Temporarily Restricted\n` +
            `**Effective Date**: ${new Date().toLocaleDateString()}\n\n` +
            `During this time, you will not be able to place orders until the restriction period ends.\n\n` +
            `If you believe this is an error, please contact our support team.`;
        
        await bot.sendMessage(userId, userWarningNotice, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error('Warning notification delivery failed:', error);
    }
    
    const adminSummary = `⚠️ **Temporary Ban Applied**\n\n` +
        `**Target Account**: ${userId}\n` +
        `**Restriction Type**: Temporary (2 days)\n` +
        `**Reason**: Minor violation\n` +
        `**Authorized By**: ${msg.from.username ? `@${msg.from.username}` : msg.from.first_name}\n` +
        `**Timestamp**: ${new Date().toLocaleString()}`;
    
    await bot.sendMessage(chatId, adminSummary, {
        parse_mode: 'Markdown',
        reply_to_message_id: msg.message_id
    });

    setTimeout(async () => {
        await Warning.updateOne(
            { userId: userId, type: 'warning', isActive: true, autoRemove: true },
            { isActive: false }
        );
        await BannedUser.updateOne({}, { $pull: { users: userId } });
        try {
            await bot.sendMessage(userId, `✅ Your account restrictions have been lifted. You can now resume normal activities.`);
        } catch (error) {
            console.error('Failed to notify user of auto-unban:', error);
        }
    }, 2 * 24 * 60 * 60 * 1000);
});

bot.onText(/\/unban (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const requesterId = msg.from.id.toString();
    
    if (!adminIds.includes(requesterId)) {
        return bot.sendMessage(chatId, '⛔ **Access Denied**\n\nInsufficient privileges to execute this command.', {
            parse_mode: 'Markdown',
            reply_to_message_id: msg.message_id
        });
    }
    
    const userId = match[1];
    const activeWarning = await Warning.findOne({ userId: userId, isActive: true });
    
    if (!activeWarning) {
        return bot.sendMessage(chatId, `⚠️ User ${userId} is not currently banned.`, {
            reply_to_message_id: msg.message_id
        });
    }
    
    await Warning.updateOne(
        { userId: userId, isActive: true },
        { isActive: false }
    );
    await BannedUser.updateOne({}, { $pull: { users: userId } });
    
    try {
        const reinstatementNotice = `**ACCOUNT RESTORED**\n\n` +
            `Your account has been restored to full functionality.\n\n` +
            `**Account Status**: Active\n` +
            `**Restoration Date**: ${new Date().toLocaleDateString()}\n\n` +
            `You can now resume all normal activities including placing orders.`;
        
        await bot.sendMessage(userId, reinstatementNotice, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error('Reinstatement notification delivery failed:', error);
    }
    
    const adminConfirmation = `✅ **Account Unbanned**\n\n` +
        `**Account**: ${userId}\n` +
        `**Status**: Active\n` +
        `**Authorized By**: ${msg.from.username ? `@${msg.from.username}` : msg.from.first_name}\n` +
        `**Timestamp**: ${new Date().toLocaleString()}`;
    
    await bot.sendMessage(chatId, adminConfirmation, {
        parse_mode: 'Markdown',
        reply_to_message_id: msg.message_id
    });
});

bot.onText(/\/warnings (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const requesterId = msg.from.id.toString();
    
    if (!adminIds.includes(requesterId)) {
        return bot.sendMessage(chatId, '⛔ **Access Denied**\n\nInsufficient privileges to execute this command.', {
            parse_mode: 'Markdown',
            reply_to_message_id: msg.message_id
        });
    }
    
    const userId = match[1];
    const warnings = await Warning.find({ userId: userId }).sort({ issuedAt: -1 }).limit(10);
    
    if (warnings.length === 0) {
        return bot.sendMessage(chatId, `📋 No warnings found for user ${userId}.`, {
            reply_to_message_id: msg.message_id
        });
    }
    
    let warningsList = `📋 **Warning History for User ${userId}**\n\n`;
    
    warnings.forEach((warning, index) => {
        const status = warning.isActive ? '🔴 Active' : '✅ Resolved';
        const expiry = warning.expiresAt ? `\n**Expires**: ${warning.expiresAt.toLocaleDateString()}` : '';
        
        warningsList += `**${index + 1}.** ${warning.type.toUpperCase()}\n` +
            `**Status**: ${status}\n` +
            `**Reason**: ${warning.reason}\n` +
            `**Date**: ${warning.issuedAt.toLocaleDateString()}${expiry}\n\n`;
    });
    
    await bot.sendMessage(chatId, warningsList, {
        parse_mode: 'Markdown',
        reply_to_message_id: msg.message_id
    });
});

setInterval(async () => {
    const expiredWarnings = await Warning.find({
        isActive: true,
        autoRemove: true,
        expiresAt: { $lte: new Date() }
    });
    
    for (const warning of expiredWarnings) {
        await Warning.updateOne(
            { _id: warning._id },
            { isActive: false }
        );
        await BannedUser.updateOne({}, { $pull: { users: warning.userId } });
        
        try {
            await bot.sendMessage(warning.userId, `✅ Your account restrictions have been lifted. You can now resume normal activities.`);
        } catch (error) {
            console.error('Failed to notify user of auto-unban:', error);
        }
    }
}, 60000);


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

bot.onText(/\/reply\s+([0-9]+(?:\s*,\s*[0-9]+)*)(?:\s+([\s\S]+))?/, async (msg, match) => {
    try {
        // Verify admin (using your existing adminIds)
        if (!adminIds.includes(String(msg.from.id))) {
            return await bot.sendMessage(msg.chat.id, "❌ Unauthorized");
        }

        const recipientsRaw = match[1] || '';
        const textMessage = match[2] || '';
        const hasText = (textMessage || '').trim().length > 0;

        const recipientIds = Array.from(new Set(
            recipientsRaw
                .split(/[\s,]+/)
                .map(id => id.trim())
                .filter(id => id && /^\d+$/.test(id))
        ));

        if (recipientIds.length === 0) {
            return await bot.sendMessage(msg.chat.id, '❌ No valid user IDs provided. Use: /reply <id1,id2,...> <message>');
        }

        if (recipientIds.length > REPLY_MAX_RECIPIENTS) {
            return await bot.sendMessage(msg.chat.id, `❌ Too many recipients (${recipientIds.length}). Max allowed is ${REPLY_MAX_RECIPIENTS}.`);
        }

        if (!msg.reply_to_message && !hasText) {
            throw new Error('No message content provided');
        }

        if (!msg.reply_to_message && hasText && textMessage.length > 4000) {
            throw new Error('Message exceeds 4000 character limit');
        }

        const mediaMsg = msg.reply_to_message || null;
        const results = [];

        for (const userId of recipientIds) {
            try {
                if (mediaMsg) {
                    if (mediaMsg.photo) {
                        await bot.sendPhoto(
                            userId,
                            mediaMsg.photo.slice(-1)[0].file_id,
                            { caption: hasText ? textMessage : '📨 Admin Reply' }
                        );
                    } else if (mediaMsg.document) {
                        await bot.sendDocument(
                            userId,
                            mediaMsg.document.file_id,
                            { caption: hasText ? textMessage : '📨 Admin Reply' }
                        );
                    } else if (mediaMsg.video) {
                        await bot.sendVideo(
                            userId,
                            mediaMsg.video.file_id,
                            { caption: hasText ? textMessage : '📨 Admin Reply' }
                        );
                    } else if (mediaMsg.audio) {
                        await bot.sendAudio(
                            userId,
                            mediaMsg.audio.file_id,
                            { caption: hasText ? textMessage : '📨 Admin Reply' }
                        );
                    } else if (mediaMsg.voice) {
                        await bot.sendVoice(
                            userId,
                            mediaMsg.voice.file_id,
                            { caption: hasText ? textMessage : '📨 Admin Reply' }
                        );
                    } else if (hasText) {
                        await bot.sendMessage(userId, `📨 Admin Reply:\n\n${textMessage}`);
                    } else {
                        throw new Error('No message content found');
                    }
                } else {
                    await bot.sendMessage(userId, `📨 Admin Reply:\n\n${textMessage}`);
                }

                results.push({ userId, ok: true });
            } catch (err) {
                let reason = err && err.message ? err.message : 'Unknown error';
                if (err && err.response && err.response.error_code === 403) {
                    reason = "User has blocked the bot or doesn't exist";
                } else if (reason.includes('chat not found')) {
                    reason = "User hasn't started a chat with the bot";
                }
                results.push({ userId, ok: false, reason });
            }
        }

        const successCount = results.filter(r => r.ok).length;
        const failureCount = results.length - successCount;
        let summary = `📬 Delivery report (${successCount} sent, ${failureCount} failed):\n\n`;
        summary += results.map(r => r.ok ? `✅ ${r.userId}` : `❌ ${r.userId} — ${r.reason}`).join('\n');

        await bot.sendMessage(msg.chat.id, summary);
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

// Enhanced notification fetching with pagination and unread count
app.get('/api/notifications', requireTelegramAuth, async (req, res) => {
    try {
        const { limit = 20, skip = 0 } = req.query;
        const userId = req.user.id;

        const userNotifications = await UserNotification.find({ userId })
            .sort({ createdAt: -1 })
            .skip(parseInt(skip))
            .limit(parseInt(limit))
            .lean();

        const templateIds = userNotifications.map(n => n.templateId);
        const templates = await NotificationTemplate.find({ _id: { $in: templateIds } }).lean();
        const templateMap = new Map(templates.map(t => [t._id.toString(), t]));

        const formattedNotifications = userNotifications.map(n => {
            const t = templateMap.get(n.templateId.toString());
            return {
                id: n._id.toString(),
                title: t?.title || 'Notification',
                message: t?.message || '',
                actionUrl: t?.actionUrl,
                icon: t?.icon || 'fa-bell',
                createdAt: n.createdAt,
                read: n.read,
                priority: t?.priority ?? 0
            };
        });

        const unreadCount = await UserNotification.countDocuments({ userId, read: false });

        res.json({ notifications: formattedNotifications, unreadCount, totalCount: await UserNotification.countDocuments({ userId }) });
    } catch (error) {
        console.error('Error fetching notifications:', error);
        res.status(500).json({ error: "Failed to fetch notifications" });
    }
});

// Unread notifications count endpoint to support frontend polling
app.get('/api/notifications/unread-count', requireTelegramAuth, async (req, res) => {
    try {
        const userId = req.user.id;
        const unreadCount = await UserNotification.countDocuments({ userId, read: false });
        res.json({ unreadCount });
    } catch (error) {
        console.error('Error fetching unread notifications count:', error);
        res.status(500).json({ error: 'Failed to fetch unread notifications count' });
    }
});

// Dev-only: seed sample notifications for local verification
if (process.env.NODE_ENV !== 'production') {
    app.post('/dev/seed-notifications', async (req, res) => {
        try {
            const { userId = 'test-user', count = 3 } = req.body || {};
            const templates = [];
            for (let i = 0; i < Number(count) || 0; i++) {
                templates.push({
                    title: `Test Notification ${i + 1}`,
                    message: `This is a test notification #${i + 1}`,
                    audience: 'user',
                    targetUserId: userId,
                    priority: i % 3,
                    icon: 'fa-bell',
                });
            }
            templates.push({
                title: 'Global Announcement',
                message: 'This is a global message visible to all users',
                audience: 'global',
                priority: 1,
                icon: 'fa-bullhorn'
            });

            const createdTemplates = await NotificationTemplate.insertMany(templates);

            // Fan out user-scoped templates to UserNotification for that user
            const directTemplates = createdTemplates.filter(t => t.audience === 'user');
            const userNotifs = directTemplates.map(t => ({ userId, templateId: t._id }));

            // For global, just create one example user mapping to verify UI for dev user
            const globalTemplate = createdTemplates.find(t => t.audience === 'global');
            if (globalTemplate) userNotifs.push({ userId, templateId: globalTemplate._id });

            await UserNotification.insertMany(userNotifs);
            res.json({ success: true, createdTemplates: createdTemplates.length, createdUserNotifications: userNotifs.length });
        } catch (error) {
            console.error('Error seeding notifications:', error);
            res.status(500).json({ error: 'Failed to seed notifications' });
        }
    });
}

// Create notification with enhanced validation
app.post('/api/notifications', requireTelegramAuth, async (req, res) => {
    try {
        const { targetUserId, title, message, actionUrl, audience = 'global', priority = 0 } = req.body;
        
        // Enhanced validation
        if (!message || typeof message !== 'string' || message.trim().length === 0) {
            return res.status(400).json({ error: "Valid message is required" });
        }

        // Admin check (implement your actual admin verification)
        if (!req.user || !req.user.isAdmin) {
            return res.status(403).json({ error: "Unauthorized: Admin access required" });
        }

        const template = await NotificationTemplate.create({
            title: title || 'Notification',
            message: message.trim(),
            actionUrl,
            audience: audience === 'user' ? 'user' : 'global',
            targetUserId: audience === 'user' ? (targetUserId || '').toString() : undefined,
            priority: Math.min(2, Math.max(0, parseInt(priority) || 0)),
            createdBy: req.user.id
        });

        // Fan out: for user audience, create one UserNotification for that user.
        if (template.audience === 'user' && template.targetUserId) {
            await UserNotification.create({ userId: template.targetUserId, templateId: template._id });
        }

        res.status(201).json({ id: template._id, success: true, message: "Notification created successfully" });
    } catch (error) {
        console.error('Error creating notification:', error);
        res.status(500).json({ error: "Failed to create notification" });
    }
});

// Enhanced mark as read endpoint
app.post('/api/notifications/:id/read', requireTelegramAuth, async (req, res) => {
    try {
        const { id } = req.params; // this is UserNotification id now
        const userId = req.user.id;

        const updated = await UserNotification.findOneAndUpdate({ _id: id, userId }, { $set: { read: true } });
        if (!updated) return res.status(404).json({ error: 'Notification not found' });
        res.json({ success: true });
    } catch (error) {
        console.error('Error marking notification as read:', error);
        res.status(500).json({ error: "Failed to mark notification as read" });
    }
});

// Optimized mark all as read
app.post('/api/notifications/mark-all-read', requireTelegramAuth, async (req, res) => {
    try {
        const userId = req.user.id;
        const result = await UserNotification.updateMany({ userId, read: false }, { $set: { read: true } });
        res.json({ success: true, markedCount: result.modifiedCount });
    } catch (error) {
        console.error('Error marking all notifications as read:', error);
        res.status(500).json({ error: "Failed to mark all notifications as read" });
    }
});

// Enhanced notification deletion with ownership check
app.delete('/api/notifications/:id', requireTelegramAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;

        // Try delete as user-owned notification first
        const deleted = await UserNotification.findOneAndDelete({ _id: id, userId });
        if (deleted) return res.json({ success: true });

        // If not found and user is admin, allow deleting template and cascade
        if (req.user.isAdmin) {
            const template = await NotificationTemplate.findById(id);
            if (!template) return res.status(404).json({ error: 'Notification not found' });
            await NotificationTemplate.deleteOne({ _id: id });
            await UserNotification.deleteMany({ templateId: id });
            return res.json({ success: true, deletedTemplate: true });
        }

        return res.status(404).json({ error: 'Notification not found' });
    } catch (error) {
        console.error('Error dismissing notification:', error);
        res.status(500).json({ error: "Failed to dismiss notification" });
    }
});

// Enhanced Telegram bot command handler with more options
bot.onText(/\/notify(?:\s+(all|@\w+|\d+))?\s+(.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!adminIds.includes(chatId.toString())) {
        return bot.sendMessage(chatId, '❌ Unauthorized: Only admins can use this command.');
    }

    const [_, target, notificationMessage] = match;
    const timestamp = new Date();

    try {
        let notification;
        let responseMessage;

        if (target === 'all') {
            notification = await Notification.create({
                title: 'Global Announcement',
                message: notificationMessage,
                isGlobal: true,
                priority: 1 // Higher priority for admin announcements
            });
            responseMessage = `🌍 Global notification sent at ${timestamp.toLocaleTimeString()}`;
        } 
        else if (target && (target.startsWith('@') || !isNaN(target))) {
            const userId = target.startsWith('@') ? target.substring(1) : target;
            notification = await Notification.create({
                title: 'Personal Message',
                userId: userId,
                message: notificationMessage,
                isGlobal: false,
                priority: 2 // Highest priority for personal admin messages
            });
            responseMessage = `👤 Notification sent to ${target}`;
        } 
        else {
            notification = await Notification.create({
                title: 'System Notification',
                message: notificationMessage,
                isGlobal: true
            });
            responseMessage = `✅ Notification sent`;
        }

        // Format the response with timestamp and preview
        await bot.sendMessage(chatId,
            `${responseMessage} at ${timestamp.toLocaleTimeString()}:\n\n` +
            `${notificationMessage.substring(0, 100)}${notificationMessage.length > 100 ? '...' : ''}`
        );

    } catch (err) {
        console.error('Notification error:', err);
        bot.sendMessage(chatId, '❌ Failed to send notification: ' + err.message);
    }
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

function requireAdmin(req, res, next) {
	try {
		const tgId = (req.headers['x-telegram-id'] || '').toString();
		if (tgId && Array.isArray(adminIds) && adminIds.includes(tgId)) {
			req.user = { id: tgId, isAdmin: true };
			return next();
		}
		return res.status(403).json({ error: 'Forbidden' });
	} catch (e) {
		return res.status(403).json({ error: 'Forbidden' });
	}
}

app.get('/api/me', (req, res) => {
	const sess = getAdminSession(req);
	if (sess && adminIds.includes(sess.payload.tgId)) {
		return res.json({ id: sess.payload.tgId, isAdmin: true });
	}
	const tgId = (req.headers['x-telegram-id'] || '').toString();
	return res.json({ id: tgId || null, isAdmin: tgId ? adminIds.includes(tgId) : false });
});

// Basic admin stats
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
	try {
		const [totalOrders, pendingWithdrawals, totalUsers, revenueUsdt] = await Promise.all([
			Promise.resolve(await BuyOrder.countDocuments({}).catch(()=>0) + await SellOrder.countDocuments({}).catch(()=>0)),
			ReferralWithdrawal.countDocuments({ status: 'pending' }).catch(()=>0),
			User.countDocuments({}).catch(()=>0),
			Promise.resolve(0)
		]);
		res.json({ totalOrders, pendingWithdrawals, totalUsers, revenueUsdt });
	} catch (e) {
		res.status(500).json({ error: 'Failed to load stats' });
	}
});

// List recent orders (buy + sell)
app.get('/api/admin/orders', requireAdmin, async (req, res) => {
	try {
		const limit = Math.min(parseInt(req.query.limit) || 20, 200);
		const page = Math.max(parseInt(req.query.page) || 1, 1);
		const status = (req.query.status || '').toString().trim();
		const q = (req.query.q || '').toString().trim();

		const textFilter = q ? { $or: [
			{ id: { $regex: q, $options: 'i' } },
			{ username: { $regex: q, $options: 'i' } },
			{ telegramId: { $regex: q, $options: 'i' } }
		] } : {};
		const statusFilter = status ? { status } : {};

		const [buyCount, sellCount] = await Promise.all([
			BuyOrder.countDocuments({ ...statusFilter, ...textFilter }).catch(()=>0),
			SellOrder.countDocuments({ ...statusFilter, ...textFilter }).catch(()=>0)
		]);

		const take = limit * page;
		const [buys, sells] = await Promise.all([
			BuyOrder.find({ ...statusFilter, ...textFilter }).sort({ dateCreated: -1 }).limit(take).lean(),
			SellOrder.find({ ...statusFilter, ...textFilter }).sort({ dateCreated: -1 }).limit(take).lean()
		]);

		const merged = [
			...buys.map(b => ({ id: b.id, type: 'buy', username: b.username, telegramId: b.telegramId, amount: b.amount, status: b.status, dateCreated: b.dateCreated })),
			...sells.map(s => ({ id: s.id, type: 'sell', username: s.username, telegramId: s.telegramId, amount: s.amount, status: s.status, dateCreated: s.dateCreated }))
		].sort((a,b)=> new Date(b.dateCreated) - new Date(a.dateCreated));

		const start = (page - 1) * limit;
		const orders = merged.slice(start, start + limit);
		const total = buyCount + sellCount;
		res.json({ orders, total });
	} catch (e) {
		res.status(500).json({ error: 'Failed to load orders' });
	}
});

app.get('/api/admin/orders/export', requireAdmin, async (req, res) => {
	try {
		const status = (req.query.status || '').toString().trim();
		const q = (req.query.q || '').toString().trim();
		const textFilter = q ? { $or: [
			{ id: { $regex: q, $options: 'i' } },
			{ username: { $regex: q, $options: 'i' } },
			{ telegramId: { $regex: q, $options: 'i' } }
		] } : {};
		const statusFilter = status ? { status } : {};
		const limit = Math.min(parseInt(req.query.limit) || 5000, 20000);
		const [buys, sells] = await Promise.all([
			BuyOrder.find({ ...statusFilter, ...textFilter }).sort({ dateCreated: -1 }).limit(limit).lean(),
			SellOrder.find({ ...statusFilter, ...textFilter }).sort({ dateCreated: -1 }).limit(limit).lean()
		]);
		const rows = [
			...buys.map(b => ({ id: b.id, type: 'buy', username: b.username, telegramId: b.telegramId, amount: b.amount, status: b.status, dateCreated: b.dateCreated })),
			...sells.map(s => ({ id: s.id, type: 'sell', username: s.username, telegramId: s.telegramId, amount: s.amount, status: s.status, dateCreated: s.dateCreated }))
		].sort((a,b)=> new Date(b.dateCreated) - new Date(a.dateCreated));
		const csv = ['id,type,username,telegramId,amount,status,dateCreated']
			.concat(rows.map(r => [r.id, r.type, r.username || '', r.telegramId || '', r.amount || 0, r.status || '', new Date(r.dateCreated || Date.now()).toISOString()]
				.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',')))
			.join('\n');
		res.setHeader('Content-Type', 'text/csv');
		res.setHeader('Content-Disposition', 'attachment; filename="orders.csv"');
		return res.send(csv);
	} catch (e) {
		return res.status(500).send('Failed to export');
	}
});

// Order actions
app.post('/api/admin/orders/:id/complete', requireAdmin, async (req, res) => {
    try {
        const id = req.params.id;
        // Try buy first, then sell
        let order = await BuyOrder.findOne({ id });
        let orderType = 'buy';
        if (!order) { order = await SellOrder.findOne({ id }); orderType = 'sell'; }
        if (!order) return res.status(404).json({ error: 'Order not found' });

        if (orderType === 'sell' && order.status !== 'processing') {
            return res.status(409).json({ error: `Order is ${order.status} - cannot complete` });
        }
        if (orderType === 'buy' && order.status !== 'pending') {
            return res.status(409).json({ error: `Order is ${order.status} - cannot complete` });
        }

        order.status = 'completed';
        order.dateCompleted = new Date();
        await order.save();

        // Mirror side effects
        if (orderType === 'sell') {
            if (order.stars) { try { await trackStars(order.telegramId, order.stars, 'sell'); } catch {} }
        } else {
            if (!order.isPremium && order.stars) { try { await trackStars(order.telegramId, order.stars, 'buy'); } catch {} }
            if (order.isPremium) { try { await trackPremiumActivation(order.telegramId); } catch {} }
        }

        // Collapse admin buttons
        const statusText = '✅ Completed';
        const processedBy = `Processed by: @${req.user?.id || 'admin'}`;
        if (order.adminMessages?.length) {
            await Promise.all(order.adminMessages.map(async (adminMsg) => {
                const baseText = adminMsg.originalText || '';
                const updatedText = `${baseText}\n\n${statusText}\n${processedBy}${orderType === 'sell' ? '\n\nPayments have been transferred to the seller.' : ''}`;
                try {
                    await bot.editMessageText(updatedText, {
                        chat_id: adminMsg.adminId,
                        message_id: adminMsg.messageId,
                        reply_markup: { inline_keyboard: [[{ text: statusText, callback_data: `processed_${order.id}_${Date.now()}` }]] }
                    });
                } catch {}
            }));
        }

        // Notify user
        const userMessage = `✅ Your ${orderType} order #${order.id} has been confirmed!${orderType === 'sell' ? '\n\nPayment has been sent to your wallet.' : '\n\nThank you for choosing StarStore!'}`;
        try { await bot.sendMessage(order.telegramId, userMessage); } catch {}

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Failed to complete order' });
    }
});

app.post('/api/admin/orders/:id/decline', requireAdmin, async (req, res) => {
    try {
        const id = req.params.id;
        let order = await BuyOrder.findOne({ id });
        let orderType = 'buy';
        if (!order) { order = await SellOrder.findOne({ id }); orderType = 'sell'; }
        if (!order) return res.status(404).json({ error: 'Order not found' });

        order.status = orderType === 'sell' ? 'failed' : 'declined';
        order.dateDeclined = new Date();
        await order.save();

        const statusText = order.status === 'failed' ? '❌ Failed' : '❌ Declined';
        const processedBy = `Processed by: @${req.user?.id || 'admin'}`;
        if (order.adminMessages?.length) {
            await Promise.all(order.adminMessages.map(async (adminMsg) => {
                const baseText = adminMsg.originalText || '';
                const updatedText = `${baseText}\n\n${statusText}\n${processedBy}`;
                try {
                    await bot.editMessageText(updatedText, {
                        chat_id: adminMsg.adminId,
                        message_id: adminMsg.messageId,
                        reply_markup: { inline_keyboard: [[{ text: statusText, callback_data: `processed_${order.id}_${Date.now()}` }]] }
                    });
                } catch {}
            }));
        }

        const userMessage = order.status === 'failed' 
          ? `❌ Your sell order #${order.id} has failed.\n\nPlease try selling a lower amount or contact support if the issue persist.`
          : `❌ Your buy order #${order.id} has been declined.\n\nPlease contact support if you believe this was a mistake.`;
        try { await bot.sendMessage(order.telegramId, userMessage); } catch {}
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Failed to decline order' });
    }
});

app.post('/api/admin/orders/:id/refund', requireAdmin, async (req, res) => {
    try {
        const id = req.params.id;
        const order = await SellOrder.findOne({ id });
        if (!order) return res.status(404).json({ error: 'Sell order not found' });

        order.status = 'refunded';
        order.dateRefunded = new Date();
        await order.save();

        const statusText = '💸 Refunded';
        const processedBy = `Processed by: @${req.user?.id || 'admin'}`;
        if (order.adminMessages?.length) {
            await Promise.all(order.adminMessages.map(async (adminMsg) => {
                const baseText = adminMsg.originalText || '';
                const updatedText = `${baseText}\n\n${statusText}\n${processedBy}`;
                try {
                    await bot.editMessageText(updatedText, {
                        chat_id: adminMsg.adminId,
                        message_id: adminMsg.messageId,
                        reply_markup: { inline_keyboard: [[{ text: statusText, callback_data: `processed_${order.id}_${Date.now()}` }]] }
                    });
                } catch {}
            }));
        }

        const userMessage = `💸 Your sell order #${order.id} has been refunded.\n\nPlease check your Account for the refund.`;
        try { await bot.sendMessage(order.telegramId, userMessage); } catch {}
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Failed to refund order' });
    }
});

// List recent withdrawals
app.get('/api/admin/withdrawals', requireAdmin, async (req, res) => {
	try {
		const limit = Math.min(parseInt(req.query.limit) || 20, 200);
		const page = Math.max(parseInt(req.query.page) || 1, 1);
		const status = (req.query.status || '').toString().trim();
		const qq = (req.query.q || '').toString().trim();
		const statusFilter = status ? { status } : {};
		const textFilter = qq ? { $or: [
			{ userId: { $regex: qq, $options: 'i' } },
			{ username: { $regex: qq, $options: 'i' } },
			{ walletAddress: { $regex: qq, $options: 'i' } },
		] } : {};
		const total = await ReferralWithdrawal.countDocuments({ ...statusFilter, ...textFilter }).catch(()=>0);
		const withdrawals = await ReferralWithdrawal.find({ ...statusFilter, ...textFilter })
			.sort({ createdAt: -1 })
			.skip((page - 1) * limit)
			.limit(limit)
			.lean();
		res.json({ withdrawals, total });
	} catch (e) {
		res.status(500).json({ error: 'Failed to load withdrawals' });
	}
});

app.get('/api/admin/withdrawals/export', requireAdmin, async (req, res) => {
	try {
		const status = (req.query.status || '').toString().trim();
		const q = (req.query.q || '').toString().trim();
		const statusFilter = status ? { status } : {};
		const textFilter = q ? { $or: [
			{ userId: { $regex: q, $options: 'i' } },
			{ username: { $regex: q, $options: 'i' } },
			{ walletAddress: { $regex: q, $options: 'i' } }
		] } : {};
		const limit = Math.min(parseInt(req.query.limit) || 5000, 20000);
		const withdrawals = await ReferralWithdrawal
			.find({ ...statusFilter, ...textFilter })
			.sort({ createdAt: -1 })
			.limit(limit)
			.lean();
		const csv = ['id,userId,username,amount,walletAddress,status,reason,createdAt']
			.concat(withdrawals.map(w => [w._id, w.userId || '', w.username || '', w.amount || 0, w.walletAddress || '', w.status || '', w.declineReason || '', new Date(w.createdAt || Date.now()).toISOString()]
				.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',')))
			.join('\n');
		res.setHeader('Content-Type', 'text/csv');
		res.setHeader('Content-Disposition', 'attachment; filename="withdrawals.csv"');
		return res.send(csv);
	} catch (e) {
		return res.status(500).send('Failed to export');
	}
});

// Complete a withdrawal
app.post('/api/admin/withdrawals/:id/complete', requireAdmin, async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const id = req.params.id;
        const admin = req.user?.id || 'admin';

        const withdrawal = await ReferralWithdrawal.findOneAndUpdate(
            { _id: new mongoose.Types.ObjectId(id), status: 'pending' },
            { $set: { status: 'completed', processedBy: parseInt(admin, 10) || admin, processedAt: new Date() } },
            { new: true, session }
        );
        if (!withdrawal) {
            await session.abortTransaction();
            return res.status(409).json({ error: 'Withdrawal not found or already processed' });
        }

        // Notify user
        try {
            await bot.sendMessage(withdrawal.userId, `✅ Withdrawal WD${withdrawal._id.toString().slice(-8).toUpperCase()} Completed!\n\nAmount: ${withdrawal.amount} USDT\nWallet: ${withdrawal.walletAddress}\n\nFunds have been sent to your wallet.`);
        } catch {}

        // Update admin messages to collapsed status
        const statusText = '✅ Completed';
        const processedBy = `Processed by: @${req.user?.id || 'admin'}`;
        if (withdrawal.adminMessages?.length) {
            await Promise.all(withdrawal.adminMessages.map(async (adminMsg) => {
                if (!adminMsg?.adminId || !adminMsg?.messageId) return;
                const baseText = adminMsg.originalText || '';
                const updatedText = `${baseText}\n\nStatus: ${statusText}\n${processedBy}\nProcessed at: ${new Date().toLocaleString()}`;
                try {
                    await bot.editMessageText(updatedText, {
                        chat_id: parseInt(adminMsg.adminId, 10) || adminMsg.adminId,
                        message_id: adminMsg.messageId,
                        reply_markup: { inline_keyboard: [[{ text: statusText, callback_data: `processed_withdrawal_${withdrawal._id}_${Date.now()}` }]] }
                    });
                } catch {
                    try {
                        await bot.editMessageReplyMarkup(
                            { inline_keyboard: [[{ text: statusText, callback_data: `processed_withdrawal_${withdrawal._id}_${Date.now()}` }]] },
                            { chat_id: parseInt(adminMsg.adminId, 10) || adminMsg.adminId, message_id: adminMsg.messageId }
                        );
                    } catch {}
                }
            }));
        }

        await session.commitTransaction();
        return res.json({ success: true });
    } catch (e) {
        await session.abortTransaction();
        return res.status(500).json({ error: 'Failed to complete withdrawal' });
    } finally {
        session.endSession();
    }
});

// Decline a withdrawal with reason
app.post('/api/admin/withdrawals/:id/decline', requireAdmin, async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const id = req.params.id;
        const { reason } = req.body || {};
        const admin = req.user?.id || 'admin';

        const withdrawal = await ReferralWithdrawal.findOneAndUpdate(
            { _id: new mongoose.Types.ObjectId(id), status: 'pending' },
            { $set: { status: 'declined', processedBy: parseInt(admin, 10) || admin, processedAt: new Date(), declineReason: reason || 'Declined' } },
            { new: true, session }
        );
        if (!withdrawal) {
            await session.abortTransaction();
            return res.status(409).json({ error: 'Withdrawal not found or already processed' });
        }

        // Revert referral withdrawn flags
        await Referral.updateMany(
            { _id: { $in: withdrawal.referralIds } },
            { $set: { withdrawn: false } },
            { session }
        );

        // Notify user with reason
        try {
            await bot.sendMessage(withdrawal.userId, `❌ Withdrawal WD${withdrawal._id.toString().slice(-8).toUpperCase()} Declined\nReason: ${withdrawal.declineReason}\n\nAmount: ${withdrawal.amount} USDT\nContact support for more information.`);
        } catch {}

        // Update admin messages
        const statusText = '❌ Declined';
        const processedBy = `Processed by: @${req.user?.id || 'admin'}`;
        if (withdrawal.adminMessages?.length) {
            await Promise.all(withdrawal.adminMessages.map(async (adminMsg) => {
                if (!adminMsg?.adminId || !adminMsg?.messageId) return;
                const baseText = adminMsg.originalText || '';
                const updatedText = `${baseText}\n\nStatus: ${statusText}\nReason: ${withdrawal.declineReason}\n${processedBy}\nProcessed at: ${new Date().toLocaleString()}`;
                try {
                    await bot.editMessageText(updatedText, {
                        chat_id: parseInt(adminMsg.adminId, 10) || adminMsg.adminId,
                        message_id: adminMsg.messageId,
                        reply_markup: { inline_keyboard: [[{ text: statusText, callback_data: `processed_withdrawal_${withdrawal._id}_${Date.now()}` }]] }
                    });
                } catch {
                    try {
                        await bot.editMessageReplyMarkup(
                            { inline_keyboard: [[{ text: statusText, callback_data: `processed_withdrawal_${withdrawal._id}_${Date.now()}` }]] },
                            { chat_id: parseInt(adminMsg.adminId, 10) || adminMsg.adminId, message_id: adminMsg.messageId }
                        );
                    } catch {}
                }
            }));
        }

        await session.commitTransaction();
        return res.json({ success: true });
    } catch (e) {
        await session.abortTransaction();
        return res.status(500).json({ error: 'Failed to decline withdrawal' });
    } finally {
        session.endSession();
    }
});

// List referrals for admin
app.get('/api/admin/referrals', requireAdmin, async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 100, 500);
        const referrals = await Referral.find({}).sort({ dateReferred: -1 }).limit(limit).lean();
        res.json({ referrals });
    } catch (e) {
        res.status(500).json({ error: 'Failed to load referrals' });
    }
});

// List users for admin
app.get('/api/admin/users', requireAdmin, async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 100, 500);
        const users = await User.find({}).sort({ createdAt: -1 }).limit(limit).lean();
        res.json({ users });
    } catch (e) {
        res.status(500).json({ error: 'Failed to load users' });
    }
});

// Send a notification (basic)
app.post('/api/admin/notify', requireAdmin, async (req, res) => {
    try {
        const { target, message } = req.body || {};
        if (!message || typeof message !== 'string' || message.trim().length === 0) {
            return res.status(400).json({ error: 'Message required' });
        }
        const sent = [];
        if (!target || target === 'all') {
            const users = await User.find({}, { id: 1 }).limit(5000);
            for (const u of users) {
                try { await bot.sendMessage(u.id, message); sent.push(u.id); } catch {}
            }
        } else if (/^@/.test(target)) {
            const username = target.replace(/^@/, '');
            const user = await User.findOne({ username });
            if (!user) return res.status(404).json({ error: 'User not found' });
            await bot.sendMessage(user.id, message); sent.push(user.id);
        } else if (/^\d+$/.test(target)) {
            await bot.sendMessage(target, message); sent.push(target);
        } else {
            return res.status(400).json({ error: 'Invalid target' });
        }
        res.json({ success: true, sent: sent.length });
    } catch (e) {
        res.status(500).json({ error: 'Failed to send notification' });
    }
});

function parseCookies(cookieHeader) {
	const out = {};
	if (!cookieHeader) return out;
	cookieHeader.split(';').forEach(part => {
		const idx = part.indexOf('=');
		if (idx > -1) {
			const k = part.slice(0, idx).trim();
			const v = part.slice(idx + 1).trim();
			out[k] = decodeURIComponent(v);
		}
	});
	return out;
}

function base64url(input) {
	return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function signAdminToken(payload, ttlMs) {
	const secret = process.env.ADMIN_JWT_SECRET || (process.env.TELEGRAM_BOT_TOKEN || 'secret');
	const header = { alg: 'HS256', typ: 'JWT' };
	const exp = Date.now() + (ttlMs || 12 * 60 * 60 * 1000);
	const body = { ...payload, exp };
	const h = base64url(JSON.stringify(header));
	const b = base64url(JSON.stringify(body));
	const sig = require('crypto').createHmac('sha256', secret).update(`${h}.${b}`).digest('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
	return `${h}.${b}.${sig}`;
}

function verifyAdminToken(token) {
	try {
		const secret = process.env.ADMIN_JWT_SECRET || (process.env.TELEGRAM_BOT_TOKEN || 'secret');
		const [h, b, sig] = token.split('.');
		const expected = require('crypto').createHmac('sha256', secret).update(`${h}.${b}`).digest('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
		if (expected !== sig) return null;
		const body = JSON.parse(Buffer.from(b.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
		if (!body || !body.exp || Date.now() > body.exp) return null;
		return body;
	} catch {
		return null;
	}
}

function getAdminSession(req) {
	const cookies = parseCookies(req.headers.cookie || '');
	const token = cookies['admin_session'];
	if (!token) return null;
	const payload = verifyAdminToken(token);
	if (!payload || !payload.sid || !payload.tgId) return null;
	return { token, payload };
}

function requireAdmin(req, res, next) {
	// Backward-compatible GET-only header auth, or cookie session with CSRF for mutations
	const sess = getAdminSession(req);
	if (sess && adminIds.includes(sess.payload.tgId)) {
		if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
			const csrf = req.headers['x-csrf-token'];
			if (!csrf || csrf !== sess.payload.sid) {
				return res.status(403).json({ error: 'CSRF check failed' });
			}
		}
		req.user = { id: sess.payload.tgId, isAdmin: true };
		return next();
	}
	try {
		const tgId = (req.headers['x-telegram-id'] || '').toString();
		if (tgId && Array.isArray(adminIds) && adminIds.includes(tgId) && (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS')) {
			req.user = { id: tgId, isAdmin: true };
			return next();
		}
		return res.status(403).json({ error: 'Forbidden' });
	} catch (e) {
		return res.status(403).json({ error: 'Forbidden' });
	}
}

app.get('/api/me', (req, res) => {
	const sess = getAdminSession(req);
	if (sess && adminIds.includes(sess.payload.tgId)) {
		return res.json({ id: sess.payload.tgId, isAdmin: true });
	}
	const tgId = (req.headers['x-telegram-id'] || '').toString();
	return res.json({ id: tgId || null, isAdmin: tgId ? adminIds.includes(tgId) : false });
});

app.get('/api/admin/csrf', (req, res) => {
	const sess = getAdminSession(req);
	if (!sess || !adminIds.includes(sess.payload.tgId)) {
		return res.status(403).json({ error: 'Forbidden' });
	}
	return res.json({ csrfToken: sess.payload.sid });
});

app.post('/api/admin/auth/send-otp', async (req, res) => {
	try {
		const tgId = (req.body?.tgId || '').toString().trim();
		if (!tgId || !/^\d+$/.test(tgId)) return res.status(400).json({ error: 'Invalid Telegram ID' });
		if (!adminIds.includes(tgId)) return res.status(403).json({ error: 'Not authorized' });
		const code = (Math.floor(100000 + Math.random() * 900000)).toString();
		const now = Date.now();
		global.__adminOtpStore = global.__adminOtpStore || new Map();
		const prev = global.__adminOtpStore.get(tgId);
		if (prev && prev.nextAllowedAt && now < prev.nextAllowedAt) {
			const waitSec = Math.ceil((prev.nextAllowedAt - now) / 1000);
			return res.status(429).json({ error: `Please wait ${waitSec}s before requesting another code` });
		}
		global.__adminOtpStore.set(tgId, { code, expiresAt: now + 5 * 60 * 1000, nextAllowedAt: now + 60 * 1000 });
		try {
			console.log(`[ADMIN OTP] Sending code to ${tgId} ...`);
			await bot.sendMessage(tgId, `StarStore Admin Login Code\n\nYour code: ${code}\n\nThis code expires in 5 minutes.`);
			console.log(`[ADMIN OTP] Code delivered to ${tgId}`);
		} catch (err) {
			console.error(`[ADMIN OTP] Delivery failed to ${tgId}:`, err?.message || err);
			return res.status(500).json({ error: 'Failed to deliver OTP. Ensure you have started the bot and try again.' });
		}
		return res.json({ success: true });
	} catch (e) {
		console.error('[ADMIN OTP] Unexpected error:', e?.message || e);
		return res.status(500).json({ error: 'Failed to send OTP' });
	}
});

app.post('/api/admin/auth/verify-otp', (req, res) => {
	try {
		const tgId = (req.body?.tgId || '').toString().trim();
		const code = (req.body?.code || '').toString().trim();
		if (!tgId || !/^\d+$/.test(tgId) || !code) return res.status(400).json({ error: 'Invalid credentials' });
		if (!adminIds.includes(tgId)) return res.status(403).json({ error: 'Not authorized' });
		global.__adminOtpStore = global.__adminOtpStore || new Map();
		const rec = global.__adminOtpStore.get(tgId);
		if (!rec || rec.code !== code || Date.now() > rec.expiresAt) return res.status(401).json({ error: 'Invalid or expired code' });
		global.__adminOtpStore.delete(tgId);
		const sid = require('crypto').randomBytes(16).toString('hex');
		const token = signAdminToken({ tgId, sid }, 12 * 60 * 60 * 1000);
		const isProd = process.env.NODE_ENV === 'production';
		const cookie = `admin_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Strict${isProd ? '; Secure' : ''}; Max-Age=${12 * 60 * 60}`;
		res.setHeader('Set-Cookie', cookie);
		return res.json({ success: true, csrfToken: sid });
	} catch {
		return res.status(500).json({ error: 'Failed to verify OTP' });
	}
});

app.post('/api/admin/logout', (req, res) => {
	try {
		res.setHeader('Set-Cookie', 'admin_session=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0');
		return res.json({ success: true });
	} catch {
		return res.json({ success: true });
	}
});
