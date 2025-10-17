#!/usr/bin/env node

// Comprehensive test script for bot activity system
const mongoose = require('mongoose');
require('dotenv').config();

// Test the bot simulator and activity tracking system
async function testBotActivitySystem() {
    console.log('🧪 Testing Bot Activity System...\n');
    
    try {
        // Connect to database
        if (process.env.MONGODB_URI) {
            await mongoose.connect(process.env.MONGODB_URI);
            console.log('✅ Connected to MongoDB');
        } else {
            console.log('❌ No MONGODB_URI found in environment');
            return;
        }

        // Import models (simplified versions for testing)
        const userSchema = new mongoose.Schema({
            id: String,
            username: String,
            lastActive: Date,
            createdAt: { type: Date, default: Date.now }
        });

        const activitySchema = new mongoose.Schema({
            userId: String,
            activityType: String,
            activityName: String,
            points: Number,
            timestamp: { type: Date, default: Date.now },
            metadata: mongoose.Schema.Types.Mixed
        });

        const dailyStateSchema = new mongoose.Schema({
            userId: String,
            currentStreak: { type: Number, default: 0 },
            totalPoints: { type: Number, default: 0 },
            lastCheckIn: Date,
            missionsCompleted: { type: [String], default: [] }
        });

        const User = mongoose.model('TestUser', userSchema);
        const Activity = mongoose.model('TestActivity', activitySchema);
        const DailyState = mongoose.model('TestDailyState', dailyStateSchema);

        // 1. Check Bot Simulator Status
        console.log('1. 🤖 Bot Simulator Status:');
        const isEnabled = process.env.ENABLE_BOT_SIMULATOR === '1';
        console.log(`   Enabled: ${isEnabled}`);
        
        if (!isEnabled) {
            console.log('   ⚠️  Bot simulator is DISABLED');
            console.log('   To enable: Set ENABLE_BOT_SIMULATOR=1 in environment');
        }

        // 2. Check for Bot Users
        console.log('\n2. 👥 Bot Users in Database:');
        const botUsers = await User.find({ 
            id: { $regex: '^200000' } 
        }).limit(10);
        
        console.log(`   Found ${botUsers.length} bot users`);
        if (botUsers.length > 0) {
            console.log('   Sample bot users:');
            botUsers.slice(0, 5).forEach(user => {
                console.log(`   - ${user.username} (ID: ${user.id})`);
            });
        } else {
            console.log('   ❌ No bot users found - bot simulator may not be working');
        }

        // 3. Check Activity Data
        console.log('\n3. 📊 Activity Data:');
        const totalActivities = await Activity.countDocuments();
        const recentActivities = await Activity.find()
            .sort({ timestamp: -1 })
            .limit(10);
        
        console.log(`   Total activities: ${totalActivities}`);
        console.log(`   Recent activities: ${recentActivities.length}`);
        
        if (recentActivities.length > 0) {
            console.log('   Recent activity sample:');
            recentActivities.slice(0, 5).forEach(activity => {
                console.log(`   - ${activity.activityType} by ${activity.userId} (${activity.points} pts)`);
            });
        } else {
            console.log('   ❌ No activities found - activity tracking may not be working');
        }

        // 4. Check Daily States
        console.log('\n4. 🎯 Daily States:');
        const totalStates = await DailyState.countDocuments();
        const activeStates = await DailyState.find({ currentStreak: { $gt: 0 } });
        
        console.log(`   Total daily states: ${totalStates}`);
        console.log(`   Active streaks: ${activeStates.length}`);

        // 5. Activity Types Analysis
        console.log('\n5. 📈 Activity Types Analysis:');
        const activityTypes = await Activity.aggregate([
            { $group: { _id: '$activityType', count: { $sum: 1 }, totalPoints: { $sum: '$points' } } },
            { $sort: { count: -1 } }
        ]);
        
        if (activityTypes.length > 0) {
            activityTypes.forEach(type => {
                console.log(`   - ${type._id}: ${type.count} activities, ${type.totalPoints} total points`);
            });
        } else {
            console.log('   ❌ No activity types found');
        }

        // 6. Check for Recent Bot Activity
        console.log('\n6. 🔍 Recent Bot Activity (last 24 hours):');
        const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const recentBotActivity = await Activity.find({
            userId: { $regex: '^200000' },
            timestamp: { $gte: yesterday }
        });
        
        console.log(`   Bot activities in last 24h: ${recentBotActivity.length}`);
        
        if (recentBotActivity.length === 0) {
            console.log('   ❌ No recent bot activity - bots may not be active');
        } else {
            console.log('   ✅ Bots are active');
        }

        // 7. Test Activity Logging Function
        console.log('\n7. 🧪 Testing Activity Logging:');
        try {
            const testUserId = 'test_user_' + Date.now();
            const testActivity = new Activity({
                userId: testUserId,
                activityType: 'test_activity',
                activityName: 'Test Activity',
                points: 10,
                metadata: { test: true }
            });
            
            await testActivity.save();
            console.log('   ✅ Activity logging works');
            
            // Clean up test data
            await Activity.deleteOne({ _id: testActivity._id });
        } catch (error) {
            console.log('   ❌ Activity logging failed:', error.message);
        }

        // 8. Recommendations
        console.log('\n8. 💡 Recommendations:');
        
        if (!isEnabled) {
            console.log('   - Enable bot simulator: Set ENABLE_BOT_SIMULATOR=1');
        }
        
        if (botUsers.length === 0) {
            console.log('   - Bot users missing: Bot simulator needs to seed users');
        }
        
        if (totalActivities < 10) {
            console.log('   - Low activity: Check if activity tracking is working');
        }
        
        if (recentBotActivity.length === 0) {
            console.log('   - No recent bot activity: Bots may not be running periodic tasks');
        }

        console.log('\n✅ Bot Activity System Test Complete!');
        
    } catch (error) {
        console.error('❌ Test failed:', error);
    } finally {
        await mongoose.disconnect();
    }
}

// Run the test
testBotActivitySystem().catch(console.error);