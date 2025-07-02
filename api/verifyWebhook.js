
require('dotenv').config();
const axios = require('axios');
const { BOT_TOKEN } = process.env;

async function verifyWebhook() {
  try {
    const { data } = await axios.get(
      `https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`
    );

    console.log('🔍 Webhook Verification Report');
    console.log('-----------------------------');
    console.log(`Status: ${data.ok ? '✅ Active' : '❌ Inactive'}`);
    console.log(`URL: ${data.result.url}`);
    console.log(`Pending Updates: ${data.result.pending_update_count}`);
    console.log(`Last Error: ${data.result.last_error_message || 'None'}`);
    console.log(`IP: ${data.result.ip_address}`);
    console.log('-----------------------------');

    return data.result;
  } catch (error) {
    console.error('Verification failed:', error.response?.data || error.message);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  verifyWebhook();
}

module.exports = verifyWebhook;
