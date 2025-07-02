
require('dotenv').config();
const axios = require('axios');

const {
  BOT_TOKEN,
  WEBHOOK_URL = 'https://tg-star-store.vercel.app/api/telegram',
  WEBHOOK_SECRET,
  NODE_ENV = 'development'
} = process.env;

// Validate configuration
const requiredVars = ['BOT_TOKEN', 'WEBHOOK_SECRET'];
if (requiredVars.some(v => !process.env[v])) {
  console.error('Missing required environment variables');
  process.exit(1);
}

const telegram = axios.create({
  baseURL: `https://api.telegram.org/bot${BOT_TOKEN}`,
  timeout: 10000
});

async function configureWebhook() {
  try {
    console.log(`🔄 [${NODE_ENV}] Configuring webhook to ${WEBHOOK_URL}`);

    // 1. Clear existing webhook
    await telegram.get('/deleteWebhook', {
      params: { drop_pending_updates: NODE_ENV === 'production' }
    });

    // 2. Set new webhook
    const { data } = await telegram.post('/setWebhook', {
      url: WEBHOOK_URL,
      secret_token: WEBHOOK_SECRET,
      max_connections: 40,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: true
    });

    console.log('✅ Webhook configured successfully');
    console.log(data);

    // 3. Verify configuration
    const { data: info } = await telegram.get('/getWebhookInfo');
    console.log('ℹ️ Current webhook info:');
    console.log(info);

    return info;
  } catch (error) {
    console.error('❌ Webhook configuration failed:');
    
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Data:', error.response.data);
      
      if (error.response.data.parameters?.retry_after) {
        const retryAfter = error.response.data.parameters.retry_after;
        console.log(`⏳ Retrying after ${retryAfter} seconds...`);
        await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
        return configureWebhook();
      }
    } else {
      console.error(error.message);
    }

    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  configureWebhook();
}

module.exports = configureWebhook;
