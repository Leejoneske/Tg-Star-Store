const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const path = require('path');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { requireTelegramAuth } = require('./middleware/telegramAuth');
const { apiLimiter, sensitiveApiLimiter, requireApiAuth, apiLogger } = require('./middleware/apiAuth');
const securityConfig = require('./config/security');

// Load environment variables
require('dotenv').config();

// Optional development skips
const SKIP_DB = process.env.SKIP_DB === '1';
const SKIP_TELEGRAM = process.env.SKIP_TELEGRAM === '1';

// Validate required environment variables (conditional in dev)
const requiredEnvVars = [
    ...(SKIP_TELEGRAM ? [] : ['TELEGRAM_BOT_TOKEN']),
    ...(SKIP_DB ? [] : ['MONGODB_URI'])
];

const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingEnvVars.length > 0) {
    console.error('❌ Missing required environment variables:', missingEnvVars);
    process.exit(1);
}

// Set default values for optional environment variables
process.env.WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://localhost:8080';
process.env.API_KEY = process.env.API_KEY || 'default-api-key-' + Math.random().toString(36).substring(7);
process.env.WALLET_ADDRESS = process.env.WALLET_ADDRESS || 'UQDefaultWalletAddress';
process.env.ADMIN_IDS = process.env.ADMIN_IDS || '';
process.env.TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'dev-webhook-secret');

console.log('✅ Environment variables configured with defaults where needed');

// Additional env validation in production
if ((process.env.NODE_ENV || '').toLowerCase() === 'production') {
    const prodErrors = [];
    if (!process.env.PROVIDER_TOKEN) prodErrors.push('PROVIDER_TOKEN');
    if (!process.env.API_KEY || process.env.API_KEY.startsWith('default-api-key-')) prodErrors.push('API_KEY');
    if (!process.env.WALLET_ADDRESS || process.env.WALLET_ADDRESS === 'UQDefaultWalletAddress') prodErrors.push('WALLET_ADDRESS');
    if (!process.env.WEBHOOK_URL || process.env.WEBHOOK_URL.includes('localhost')) prodErrors.push('WEBHOOK_URL');
    if (!process.env.TELEGRAM_WEBHOOK_SECRET && !SKIP_TELEGRAM) prodErrors.push('TELEGRAM_WEBHOOK_SECRET');
    if (prodErrors.length) {
        console.error('❌ Missing or insecure production env vars:', prodErrors);
        process.exit(1);
    }
}
// Import models
const { User, BuyOrder, SellOrder, Referral } = require('./models');

// Import managers
const PaymentManager = require('./managers/paymentManager');
const AdminManager = require('./managers/adminManager');
const UserInteractionManager = require('./managers/userInteractionManager');
const CallbackManager = require('./managers/callbackManager');
const FeedbackManager = require('./managers/feedbackManager');
const MaintenanceManager = require('./managers/maintenanceManager');
const NotificationManager = require('./managers/notificationManager');
const StickerManager = require('./managers/stickerManager');
const WithdrawalManager = require('./managers/withdrawalManager');
const ReferralTrackingManager = require('./managers/referralTrackingManager');

// Import API routes
const apiRoutes = require('./routes/apiRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const referralRoutes = require('./routes/referralRoutes');
const orderRoutes = require('./routes/orderRoutes');
const userRoutes = require('./routes/userRoutes');
const refundRoutes = require('./routes/refundRoutes');
const stickerRoutes = require('./routes/stickerRoutes');
const sitemapRoutes = require('./routes/sitemapRoutes');

const app = express();

// Security and performance middleware
app.use(helmet({
    contentSecurityPolicy: securityConfig.csp,
    referrerPolicy: securityConfig.referrerPolicy,
    permissionsPolicy: securityConfig.permissionsPolicy,
    frameguard: securityConfig.frameguard,
    hsts: securityConfig.hsts,
    noSniff: true,
    xssFilter: false
}));

// Remove X-Powered-By header entirely
app.disable('x-powered-by');

app.use(compression());

// Apply API rate limiting
app.use('/api/', apiLimiter);

// Apply stricter rate limiting to sensitive endpoints
app.use('/api/admin/', sensitiveApiLimiter);
app.use('/api/users/', sensitiveApiLimiter);

// No custom branding headers

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static('public'));

// SEO middleware - Add SEO-friendly headers
app.use((req, res, next) => {
    // Add SEO-friendly headers
    res.setHeader('X-Robots-Tag', 'index, follow');
    next();
});

// Bot configuration
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const WEBHOOK_PATH = `/webhook/${TELEGRAM_BOT_TOKEN}`;
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;

// Admin configuration
const adminIds = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').filter(Boolean) : [];

// Initialize bot with error handling
let bot;
if (SKIP_TELEGRAM) {
    bot = {
        processUpdate: () => {},
        getMe: async () => ({ ok: true }),
        setWebHook: async () => ({ ok: true })
    };
    console.log('⚠️  Telegram bot initialization skipped (SKIP_TELEGRAM=1)');
} else {
    try {
        bot = new TelegramBot(TELEGRAM_BOT_TOKEN, {
            polling: false, // Disable polling since we're using webhooks
            webHook: {
                port: process.env.PORT || 8080
            }
        });
        console.log('✅ Telegram bot initialized successfully');
    } catch (error) {
        console.error('❌ Failed to initialize Telegram bot:', error);
        process.exit(1);
    }
}

// Set webhook with error handling
async function setupWebhook() {
    if (SKIP_TELEGRAM) {
        console.log('⚠️  Skipping webhook setup (SKIP_TELEGRAM=1)');
        return;
    }
    try {
        await bot.setWebHook(`${WEBHOOK_URL}${WEBHOOK_PATH}`, {
            secret_token: TELEGRAM_WEBHOOK_SECRET || undefined
        });
        console.log('✅ Webhook set successfully');
    } catch (error) {
        console.error('❌ Failed to set webhook:', error);
        process.exit(1);
    }
}

// MongoDB connection with retry logic
async function connectToMongoDB() {
    const maxRetries = 5;
    let retries = 0;
    
    if (SKIP_DB) {
        console.log('⚠️  Skipping MongoDB connection (SKIP_DB=1)');
        return true;
    }
    while (retries < maxRetries) {
        try {
            await mongoose.connect(process.env.MONGODB_URI, {
                useNewUrlParser: true,
                useUnifiedTopology: true,
                serverSelectionTimeoutMS: 5000,
                socketTimeoutMS: 45000,
            });
            console.log('✅ Connected to MongoDB');
            return true;
        } catch (error) {
            retries++;
            console.error(`❌ MongoDB connection attempt ${retries} failed:`, error.message);
            if (retries < maxRetries) {
                console.log(`🔄 Retrying in 5 seconds... (${retries}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, 5000));
            } else {
                console.error('❌ Failed to connect to MongoDB after all retries');
                process.exit(1);
            }
        }
    }
}

// Initialize managers with proper error handling
async function initializeManagers() {
    try {
        if (SKIP_TELEGRAM) {
            console.log('⚠️  Skipping managers initialization (SKIP_TELEGRAM=1)');
            return {};
        }
        const managers = {
            paymentManager: new PaymentManager(bot),
            adminManager: new AdminManager(bot, adminIds),
            userInteractionManager: new UserInteractionManager(bot, adminIds),
            callbackManager: new CallbackManager(bot, adminIds),
            maintenanceManager: new MaintenanceManager(),
            notificationManager: new NotificationManager(bot),
            referralTrackingManager: new ReferralTrackingManager(bot, adminIds),
            stickerManager: new StickerManager(bot),
            withdrawalManager: new WithdrawalManager(bot, adminIds)
        };
        
        // Wire managers together
        managers.maintenanceManager.setStickerManager(managers.stickerManager);
        
        console.log('✅ All managers initialized successfully');
        return managers;
    } catch (error) {
        console.error('❌ Failed to initialize managers:', error);
        process.exit(1);
    }
}

// Main initialization function
async function initializeApp() {
    try {
        // Setup webhook first
        await setupWebhook();
        
        // Connect to MongoDB
        await connectToMongoDB();
        
        // Initialize managers
        await initializeManagers();
        
        console.log('✅ Application initialized successfully');
    } catch (error) {
        console.error('❌ Application initialization failed:', error);
        process.exit(1);
    }
}

// Start initialization
initializeApp();

// API routes with logging
app.use('/api', apiLogger, apiRoutes);
app.use('/api', apiLogger, notificationRoutes);
app.use('/api', apiLogger, referralRoutes);
// Order routes require bot instance
const createOrderRoutes = require('./routes/orderRoutes');
app.use('/api', apiLogger, createOrderRoutes(bot));
app.use('/api/users', apiLogger, userRoutes);
app.use('/api', apiLogger, refundRoutes);
app.use('/api', apiLogger, stickerRoutes);
app.use('/api', apiLogger, sitemapRoutes);

// Health check endpoint
app.get('/api/health', async (req, res) => {
    try {
        // Check database connection
        const dbStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
        
        // Check bot status
        let botStatus = 'unknown';
        try {
            const botInfo = await bot.getMe();
            botStatus = botInfo ? 'active' : 'inactive';
        } catch (error) {
            botStatus = 'error';
        }
        
        // Check memory usage
        const memUsage = process.memoryUsage();
        
        res.status(200).json({ 
            status: 'ok', 
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            database: dbStatus,
            bot: botStatus,
            memory: {
                rss: Math.round(memUsage.rss / 1024 / 1024) + ' MB',
                heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + ' MB',
                heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024) + ' MB'
            },
            version: require('./package.json').version,
            environment: process.env.NODE_ENV || 'development'
        });
    } catch (error) {
        res.status(500).json({ 
            status: 'error', 
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Maintenance mode endpoint (for testing 503 page)
app.get('/maintenance', (req, res) => {
    res.status(503).sendFile(path.join(__dirname, 'public', '503.html'));
});

// Error handling middleware
app.use((req, res, next) => {
    // Handle 404 errors
    if (req.accepts('html')) {
        res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
        return;
    }
    
    if (req.accepts('json')) {
        res.status(404).json({ error: 'Not found' });
        return;
    }
    
    res.status(404).type('txt').send('Not found');
});

// Handle 400 Bad Request
app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        if (req.accepts('html')) {
            res.status(400).sendFile(path.join(__dirname, 'public', '400.html'));
            return;
        }
        res.status(400).json({ error: 'Bad request' });
        return;
    }
    next(err);
});

// Handle 403 Forbidden
app.use((err, req, res, next) => {
    if (err.status === 403) {
        if (req.accepts('html')) {
            res.status(403).sendFile(path.join(__dirname, 'public', '403.html'));
            return;
        }
        res.status(403).json({ error: 'Forbidden' });
        return;
    }
    next(err);
});

// Handle 503 Service Unavailable
app.use((err, req, res, next) => {
    if (err.status === 503) {
        if (req.accepts('html')) {
            res.status(503).sendFile(path.join(__dirname, 'public', '503.html'));
            return;
        }
        res.status(503).json({ error: 'Service unavailable' });
        return;
    }
    next(err);
});

// Handle 500 Internal Server Error
app.use((err, req, res, next) => {
    console.error('Server Error:', err);
    
    if (req.accepts('html')) {
        res.status(500).sendFile(path.join(__dirname, 'public', '500.html'));
        return;
    }
    
    if (req.accepts('json')) {
        res.status(500).json({ error: 'Internal server error' });
        return;
    }
    
    res.status(500).type('txt').send('Internal server error');
});

// Webhook handler
app.post(WEBHOOK_PATH, (req, res) => {
  if (!SKIP_TELEGRAM) {
    const headerSecret = req.headers['x-telegram-bot-api-secret-token'];
    if (TELEGRAM_WEBHOOK_SECRET && headerSecret !== TELEGRAM_WEBHOOK_SECRET) {
      return res.status(403).json({ error: 'Invalid webhook secret' });
    }
    bot.processUpdate(req.body);
  }
  res.sendStatus(200);
});

// Error handling
app.use((err, req, res, next) => {
  console.error('Express error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  // Do not log full webhook path to avoid leaking the token
  console.log(`📡 Webhook configured`);
});