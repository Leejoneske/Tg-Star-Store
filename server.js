const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const path = require('path');

// Load environment variables
require('dotenv').config();

// Import models
const { User, BuyOrder, SellOrder, Referral } = require('./models');

// Import managers
const PaymentManager = require('./managers/paymentManager');
const AdminManager = require('./managers/adminManager');
const UserInteractionManager = require('./managers/userInteractionManager');
const CallbackManager = require('./managers/callbackManager');

// Import API routes
const apiRoutes = require('./routes/apiRoutes');

const app = express();

// Middleware
app.use(express.json());
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
    
    console.log('✅ All managers initialized');
  })
  .catch(err => {
    console.error('❌ MongoDB connection error:', err);
    process.exit(1);
  });

// API routes
app.use('/api', apiRoutes);

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