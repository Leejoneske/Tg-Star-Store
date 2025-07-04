
require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const app = express();

let bot;
if (!bot && process.env.BOT_TOKEN) {
  bot = new TelegramBot(process.env.BOT_TOKEN, { webHook: false });
}

const connectMongoDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 30000,
      socketTimeoutMS: 45000,
      retryWrites: true,
      retryReads: true
    });
    console.log('✅ MongoDB connected for webhook');
  } catch (err) {
    console.error('MongoDB connection error:', err);
  }
};

app.use(express.json());

app.post('/api/telegram-webhook', async (req, res) => {
  try {
    if (process.env.WEBHOOK_SECRET && 
        req.headers['x-telegram-bot-api-secret-token'] !== process.env.WEBHOOK_SECRET) {
      return res.sendStatus(403);
    }

    if (!req.body || !req.body.update_id) {
      return res.status(400).json({ error: 'Invalid request format' });
    }

    await connectMongoDB();

    if (!bot) {
      return res.status(500).json({ error: 'Bot not initialized' });
    }

    await bot.processUpdate(req.body);
    return res.sendStatus(200);
  } catch (error) {
    console.error('Webhook processing error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = app;
