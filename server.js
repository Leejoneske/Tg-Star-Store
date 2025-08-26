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
const userRoutes = require('./routes/userRoutes');
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
    xssFilter: false // Disable deprecated X-XSS-Protection
}));

app.use(compression());

// Apply API rate limiting
app.use('/api/', apiLimiter);

// Apply stricter rate limiting to sensitive endpoints
app.use('/api/admin/', sensitiveApiLimiter);
app.use('/api/user/', sensitiveApiLimiter);

// Additional security headers (only for non-helmet headers)
app.use((req, res, next) => {
    // Add any custom headers that helmet doesn't cover
    res.setHeader('X-Powered-By', 'StarStore'); // Custom header for branding
    next();
});

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

// API routes with logging
app.use('/api', apiLogger, apiRoutes);
app.use('/api/notifications', apiLogger, notificationRoutes);
app.use('/api', apiLogger, referralRoutes);
app.use('/api', apiLogger, orderRoutes);
app.use('/api/users', apiLogger, userRoutes);
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