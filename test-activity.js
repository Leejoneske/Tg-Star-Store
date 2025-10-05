// Simple test to verify activity tracking
const fetch = require('node-fetch');

async function testActivityTracking() {
    try {
        console.log('🧪 Testing activity tracking...');
        
        // Test the test endpoint
        const response = await fetch('http://localhost:3000/api/test/activity', {
            method: 'POST',
            headers: {
                'x-telegram-id': 'dev-user',
                'Content-Type': 'application/json'
            }
        });
        
        const result = await response.json();
        console.log('✅ Test result:', result);
        
        // Test daily state to see if points were added
        const stateResponse = await fetch('http://localhost:3000/api/daily/state', {
            headers: {
                'x-telegram-id': 'dev-user'
            }
        });
        
        const state = await stateResponse.json();
        console.log('📊 Daily state:', state);
        
    } catch (error) {
        console.error('❌ Test failed:', error.message);
    }
}

testActivityTracking();