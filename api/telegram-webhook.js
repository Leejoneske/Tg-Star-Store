
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');

// MongoDB connection with caching
let cachedDb = null;
const connectMongoDB = async () => {
  if (cachedDb) return cachedDb;
  
  try {
    const connection = await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 30000,
      socketTimeoutMS: 45000,
      retryWrites: true,
      retryReads: true
    });
    cachedDb = connection;
    console.log('✅ MongoDB connected for webhook');
    return connection;
  } catch (err) {
    console.error('MongoDB connection error:', err);
    throw err;
  }
};

export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Verify webhook secret
    if (process.env.WEBHOOK_SECRET && 
        req.headers['x-telegram-bot-api-secret-token'] !== process.env.WEBHOOK_SECRET) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    // Validate request body
    if (!req.body || !req.body.update_id) {
      return res.status(400).json({ error: 'Invalid request format' });
    }

    // Connect to MongoDB
    await connectMongoDB();

    // Initialize bot for this request
    if (!process.env.BOT_TOKEN) {
      return res.status(500).json({ error: 'Bot token not configured' });
    }

    const bot = new TelegramBot(process.env.BOT_TOKEN, { webHook: false });
    
    // Process the update
    await bot.processUpdate(req.body);
    
    return res.status(200).json({ success: true });

  } catch (error) {
    console.error('Webhook processing error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
