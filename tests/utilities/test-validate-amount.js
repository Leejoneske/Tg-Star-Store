/**
 * Test Suite: /api/validate-amount Endpoint
 * 
 * Test the automatic amount validation endpoint that:
 * 1. Fetches live TON/USDT rate from CoinGecko
 * 2. Calculates what TON amount SHOULD be
 * 3. Compares against client's expected TON amount
 * 4. Returns PROCEED if amount is valid, RETRY if rate changed too much
 */

const axios = require('axios');

const BASE_URL = process.env.TEST_URL || 'http://localhost:3000';
const API_ENDPOINT = `${BASE_URL}/api/validate-amount`;

console.log('🧪 Testing /api/validate-amount Endpoint');
console.log('═'.repeat(60));
console.log(`Endpoint: ${API_ENDPOINT}\n`);

// Test cases: [description, payload, expectedValid]
const testCases = [
    {
        name: 'Valid amount (8.00 USDT, 3.8095 TON expected at 2.10 rate)',
        payload: {
            usdtAmount: 8.00,
            expectedTonAmount: 3.8095
        },
        shouldPass: true,
        description: 'Standard order with stable rates - should PROCEED'
    },
    {
        name: 'Valid amount (10.00 USDT, custom stars)',
        payload: {
            usdtAmount: 10.00,
            expectedTonAmount: 4.7619
        },
        shouldPass: true,
        description: 'Custom star amount - should PROCEED if rates are stable'
    },
    {
        name: 'Rate changed significantly (10.00 USDT, 5.5000 TON expected)',
        payload: {
            usdtAmount: 10.00,
            expectedTonAmount: 5.5000  // Way too high for 10 USDT at ~2.10 rate
        },
        shouldPass: false,
        description: 'If current rate is 2.10, client expected 5.5 TON is wrong - should RETRY'
    },
    {
        name: 'Premium purchase (19.31 USDT, 3 months)',
        payload: {
            usdtAmount: 19.31,
            expectedTonAmount: 9.19  // ~9.19 at 2.10 rate
        },
        shouldPass: true,
        description: 'Premium tier - should PROCEED if rates stable'
    },
    {
        name: 'Missing expected TON amount',
        payload: {
            usdtAmount: 8.00
            // No expectedTonAmount
        },
        shouldPass: true,
        description: 'If client never calculated expected TON, always allow - should PROCEED'
    },
    {
        name: 'Zero amount (invalid)',
        payload: {
            usdtAmount: 0,
            expectedTonAmount: 0
        },
        shouldPass: false,
        description: 'Zero amounts should be rejected'
    },
    {
        name: 'Negative amount (invalid)',
        payload: {
            usdtAmount: -10,
            expectedTonAmount: -4.7619
        },
        shouldPass: false,
        description: 'Negative amounts should be rejected'
    }
];

async function runTests() {
    console.log('\n📋 Test Cases:\n');
    
    let passed = 0;
    let failed = 0;
    
    for (let i = 0; i < testCases.length; i++) {
        const testCase = testCases[i];
        console.log(`Test ${i + 1}: ${testCase.name}`);
        console.log(`  Description: ${testCase.description}`);
        console.log(`  Payload:`, JSON.stringify(testCase.payload, null, 4).split('\n').map(l => '    ' + l).join('\n'));
        
        try {
            const response = await axios.post(API_ENDPOINT, testCase.payload);
            const { valid, action, calculatedTonAmount, currentRate, reason } = response.data;
            
            console.log(`  Response:`);
            console.log(`    ✓ Status: 200`);
            console.log(`    ✓ Valid: ${valid}`);
            console.log(`    ✓ Action: ${action}`);
            console.log(`    ✓ Current Rate: ${currentRate} USDT/TON`);
            console.log(`    ✓ Calculated TON: ${calculatedTonAmount}`);
            if (reason) console.log(`    ✓ Reason: ${reason}`);
            
            // Check if result matches expectation
            if ((valid && testCase.shouldPass) || (!valid && !testCase.shouldPass)) {
                console.log(`  ✅ PASS\n`);
                passed++;
            } else {
                console.log(`  ❌ FAIL - Expected valid=${testCase.shouldPass}, got ${valid}\n`);
                failed++;
            }
        } catch (err) {
            const status = err.response?.status || 'ERROR';
            const data = err.response?.data || err.message;
            
            console.log(`  Response:`);
            console.log(`    ✗ Status: ${status}`);
            console.log(`    ✗ Error:`, JSON.stringify(data, null, 4).split('\n').map(l => '      ' + l).join('\n'));
            
            // For test cases that should fail, getting a 400 or valid=false is ok
            if (status === 400 && !testCase.shouldPass) {
                console.log(`  ✅ PASS (Expected error response)\n`);
                passed++;
            } else {
                console.log(`  ❌ FAIL\n`);
                failed++;
            }
        }
    }
    
    console.log('\n' + '═'.repeat(60));
    console.log(`\n📊 Test Results:`);
    console.log(`  ✅ Passed: ${passed}`);
    console.log(`  ❌ Failed: ${failed}`);
    console.log(`  📈 Success Rate: ${Math.round((passed / (passed + failed)) * 100)}%\n`);
    
    if (failed === 0) {
        console.log('🎉 All tests passed!\n');
        process.exit(0);
    } else {
        console.log('⚠️  Some tests failed.\n');
        process.exit(1);
    }
}

// Run all tests
runTests().catch(err => {
    console.error('Test suite error:', err);
    process.exit(1);
});
