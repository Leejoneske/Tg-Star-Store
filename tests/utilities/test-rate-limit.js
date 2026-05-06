// Simple test script to trigger rapid purchases and check admin notifications
const http = require('http');

// Test configuration
const TEST_USER_ID = '999999999'; // Test Telegram ID
const TEST_USERNAME = 'testuser';
const TEST_WALLET = 'UQAu-g5sF7qM8ZzXfZ5ZX5ZX5ZX5ZX5ZX5ZX5ZX5ZX5Zs1Zz'; // Valid TON testnet address
const ORDER_ENDPOINT = 'http://localhost:3000/api/orders/create';

// Test headers (simulating Telegram auth)
const headers = {
    'Content-Type': 'application/json',
    'x-telegram-id': TEST_USER_ID,
    'Authorization': `Bearer test_token_${TEST_USER_ID}`
};

// Payload for order creation
const createPayload = (amount = 100) => ({
    telegramId: TEST_USER_ID,
    username: TEST_USERNAME,
    stars: amount,
    walletAddress: TEST_WALLET,
    isPremium: false,
    premiumDuration: null,
    transactionHash: null,
    isTestnet: false,
    totalAmount: (amount * 0.02).toFixed(2),
    recipients: []
});

// Function to make HTTP request
function makeRequest(payload) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'localhost',
            port: 3000,
            path: '/api/orders/create',
            method: 'POST',
            headers
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve({
                        status: res.statusCode,
                        body: JSON.parse(data)
                    });
                } catch {
                    resolve({
                        status: res.statusCode,
                        body: data
                    });
                }
            });
        });

        req.on('error', reject);
        req.write(JSON.stringify(payload));
        req.end();
    });
}

// Test function: Rapid fire 5+ purchases to trigger ban
async function testRapidPurchases() {
    console.log('Starting rate limit test...\n');
    console.log('Making 6 rapid purchase requests (should trigger ban after 5th):\n');

    for (let i = 1; i <= 6; i++) {
        try {
            const payload = createPayload(50 + i);
            console.log(`[Request ${i}] Sending order for ${50 + i} stars...`);
            
            const result = await makeRequest(payload);
            console.log(`  Status: ${result.status}`);
            console.log(`  Response:`, JSON.stringify(result.body, null, 2));
            
            if (result.status === 429) {
                console.log(`  ✅ RATE LIMITED (expected after 5 attempts)`);
                if (i <= 5) console.log('  ⚠️ Ban triggered earlier than expected!');
            } else if (result.status === 200) {
                console.log(`  ✅ Order created successfully`);
            } else {
                console.log(`  ❌ Unexpected status`);
            }
            console.log('');

            // Small delay between requests
            await new Promise(r => setTimeout(r, 100));
        } catch (err) {
            console.error(`Request ${i} failed:`, err.message);
        }
    }

    console.log('\n✅ Test complete. Check server logs for admin notification attempts.');
}

testRapidPurchases().catch(console.error);
