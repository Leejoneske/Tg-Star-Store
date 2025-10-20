#!/usr/bin/env node

// Script to enable bot simulator and test it
console.log('🤖 Enabling Bot Simulator...\n');

// Set environment variable
process.env.ENABLE_BOT_SIMULATOR = '1';
console.log('✅ Set ENABLE_BOT_SIMULATOR=1');

// Test if the bot simulator would start
try {
    const { startBotSimulator } = require('./services/bot-simulator');
    console.log('✅ Bot simulator module loaded successfully');
    
    // Mock models for testing
    const mockModels = {
        User: {
            updateOne: () => Promise.resolve(),
            findOne: () => Promise.resolve(null)
        },
        DailyState: {
            findOne: () => Promise.resolve(null),
            updateOne: () => Promise.resolve()
        }
    };
    
    console.log('🧪 Testing bot simulator initialization...');
    
    const simulator = startBotSimulator({
        useMongo: false,
        models: mockModels,
        db: { data: {} },
        bots: [
            { id: '200000001', username: 'test_bot_1' },
            { id: '200000002', username: 'test_bot_2' }
        ],
        tickIntervalMs: 5000 // 5 seconds for testing
    });
    
    console.log('✅ Bot simulator started successfully');
    
    // Stop after a few seconds
    setTimeout(() => {
        if (simulator && simulator.stop) {
            simulator.stop();
            console.log('🛑 Bot simulator stopped');
        }
        process.exit(0);
    }, 10000);
    
} catch (error) {
    console.error('❌ Bot simulator test failed:', error.message);
    process.exit(1);
}

console.log('\n📋 Next Steps:');
console.log('1. Set ENABLE_BOT_SIMULATOR=1 in your Railway environment variables');
console.log('2. Redeploy your application');
console.log('3. Use /activity command to check if bots are working');
