#!/usr/bin/env node

// Test script to enable bot simulator via API
const https = require('https');
const querystring = require('querystring');

async function enableBotSimulator() {
    console.log('🧪 Testing Bot Simulator Enable API...\n');
    
    const postData = querystring.stringify({});
    
    const options = {
        hostname: 'starstore.site',
        port: 443,
        path: '/api/admin/bot-simulator/enable',
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(postData),
            'x-telegram-id': '5107333540' // Admin ID from logs
        }
    };
    
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let data = '';
            
            res.on('data', (chunk) => {
                data += chunk;
            });
            
            res.on('end', () => {
                console.log(`Status Code: ${res.statusCode}`);
                console.log(`Response: ${data}`);
                
                try {
                    const result = JSON.parse(data);
                    resolve(result);
                } catch (e) {
                    resolve({ raw: data });
                }
            });
        });
        
        req.on('error', (err) => {
            console.error('Request error:', err);
            reject(err);
        });
        
        req.write(postData);
        req.end();
    });
}

// Test the API
enableBotSimulator()
    .then(result => {
        console.log('\n✅ Bot Simulator Enable Test Complete');
        console.log('Result:', JSON.stringify(result, null, 2));
        
        if (result.success) {
            console.log('\n🎉 Bot simulator should now be enabled!');
            console.log('💡 Use /activity command to verify bot activities are being generated.');
        } else {
            console.log('\n⚠️ Bot simulator enable may have failed.');
            console.log('💡 Check Railway environment variables or server logs.');
        }
    })
    .catch(error => {
        console.error('\n❌ Test failed:', error);
    });