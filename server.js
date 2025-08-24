const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const path = require('path');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { requireTelegramAuth } = require('./middleware/telegramAuth');

// Load environment variables
require('dotenv').config();

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

// Import API routes
const apiRoutes = require('./routes/apiRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const referralRoutes = require('./routes/referralRoutes');
const orderRoutes = require('./routes/orderRoutes');
const stickerRoutes = require('./routes/stickerRoutes');

const app = express();

// Security and performance middleware
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://telegram.org", "https://cdnjs.cloudflare.com"],
            imgSrc: ["'self'", "data:", "https:", "blob:"],
            connectSrc: ["'self'", "https://api.telegram.org", "https://ton.org"],
            frameSrc: ["'self'", "https://telegram.org"],
            objectSrc: ["'none'"],
            upgradeInsecureRequests: []
        }
    }
}));

app.use(compression());

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    message: 'Too many requests from this IP, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
});

app.use('/api/', limiter);

// Additional security headers
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
});

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static('public'));

// Bot configuration
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const WEBHOOK_PATH = `/webhook/${TELEGRAM_BOT_TOKEN}`;

// Admin configuration
const adminIds = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',') : [];

// Initialize bot
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);

// Set webhook
bot.setWebHook(`${WEBHOOK_URL}${WEBHOOK_PATH}`);

// MongoDB connection
mongoose.connect(process.env.MONGODB_URI)
  .then(async () => {
    console.log('✅ Connected to MongoDB');
    
    // Initialize managers after MongoDB connection
    new PaymentManager(bot, adminIds);
    new AdminManager(bot, adminIds);
    new UserInteractionManager(bot);
    new CallbackManager(bot, adminIds);
    new FeedbackManager(bot, adminIds);
    new MaintenanceManager(bot, adminIds);
    new NotificationManager(bot, adminIds);
    
    console.log('✅ All managers initialized');
  })
  .catch(err => {
    console.error('❌ MongoDB connection error:', err);
    process.exit(1);
  });

// API routes
app.use('/api', apiRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api', referralRoutes);
app.use('/api', orderRoutes);
app.use('/api', stickerRoutes);

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
  bot.processUpdate(req.body);
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
  console.log(`📡 Webhook set to: ${WEBHOOK_URL}${WEBHOOK_PATH}`);
});