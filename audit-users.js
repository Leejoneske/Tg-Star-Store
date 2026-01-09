#!/usr/bin/env node

/**
 * User Database Audit Script
 * Checks for duplicates and data inconsistencies without modifying data
 * Usage: node audit-users.js [mongodb-uri]
 * 
 * Examples:
 *   node audit-users.js
 *   node audit-users.js "mongodb+srv://user:pass@cluster.mongodb.net/db"
 */

const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config();

// Import models - reuse the actual schema from server
const userSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true, index: true },
    username: { type: String, unique: true, sparse: true },
    email: String,
    walletAddress: String,
    createdAt: { type: Date, default: Date.now },
    lastActive: Date
});

const User = mongoose.model('User', userSchema);

async function auditUsers() {
    try {
        console.log('🔍 Starting User Database Audit...\n');
        
        // Get MongoDB URI from command line argument or environment
        const mongoUri = process.argv[2] || process.env.MONGODB_URI || 'mongodb://localhost:27017/starstore';
        
        console.log(`📡 Connecting to: ${mongoUri.replace(/:[^:]*@/, ':****@')}\n`);
        
        // Connect to MongoDB with options
        await mongoose.connect(mongoUri, {
            serverSelectionTimeoutMS: 10000,
            socketTimeoutMS: 30000
        });
        console.log('✅ Connected to MongoDB\n');

        // Get total count
        const totalUsers = await User.countDocuments();
        console.log(`📊 Total Users in Database: ${totalUsers}\n`);

        // 1. Check for duplicate user IDs (shouldn't exist due to unique index)
        console.log('🔎 Checking for duplicate User IDs...');
        const duplicateIds = await User.aggregate([
            { $group: { _id: '$id', count: { $sum: 1 } } },
            { $match: { count: { $gt: 1 } } }
        ]);
        
        if (duplicateIds.length > 0) {
            console.log(`⚠️  Found ${duplicateIds.length} duplicate ID(s):`);
            duplicateIds.forEach(dup => {
                console.log(`   - ID: ${dup._id}, Count: ${dup.count}`);
            });
        } else {
            console.log('✅ No duplicate User IDs found (as expected)\n');
        }

        // 2. Check for null/missing IDs
        console.log('🔎 Checking for null or missing User IDs...');
        const nullIds = await User.countDocuments({ id: null });
        if (nullIds > 0) {
            console.log(`⚠️  Found ${nullIds} users with null ID`);
        } else {
            console.log('✅ No users with null ID\n');
        }

        // 3. Check for duplicate usernames
        console.log('🔎 Checking for duplicate usernames...');
        const duplicateUsernames = await User.aggregate([
            { $match: { username: { $ne: null } } },
            { $group: { _id: '$username', count: { $sum: 1 }, ids: { $push: '$id' } } },
            { $match: { count: { $gt: 1 } } }
        ]);
        
        if (duplicateUsernames.length > 0) {
            console.log(`⚠️  Found ${duplicateUsernames.length} duplicate username(s):`);
            duplicateUsernames.forEach(dup => {
                console.log(`   - Username: @${dup._id}, Count: ${dup.count}`);
                console.log(`     User IDs: ${dup.ids.join(', ')}`);
            });
        } else {
            console.log('✅ No duplicate usernames found\n');
        }

        // 4. Check for users without username
        console.log('🔎 Checking for users without username...');
        const noUsername = await User.countDocuments({ username: { $in: [null, undefined, ''] } });
        if (noUsername > 0) {
            console.log(`⚠️  Found ${noUsername} users without username\n`);
        } else {
            console.log('✅ All users have a username\n');
        }

        // 5. Check for invalid data patterns
        console.log('🔎 Checking for data consistency issues...');
        const issues = [];

        // Check for users with missing createdAt
        const noCreatedAt = await User.countDocuments({ createdAt: null });
        if (noCreatedAt > 0) issues.push(`${noCreatedAt} users without createdAt`);

        // Check for users where lastActive is before createdAt (impossible)
        const timeIssues = await User.countDocuments({
            $expr: { $gt: ['$createdAt', '$lastActive'] }
        });
        if (timeIssues > 0) issues.push(`${timeIssues} users with lastActive before createdAt`);

        if (issues.length > 0) {
            console.log(`⚠️  Found data consistency issues:`);
            issues.forEach(issue => console.log(`   - ${issue}`));
        } else {
            console.log('✅ All data is consistent\n');
        }

        // 6. Database Index Status
        console.log('🔎 Checking database indexes...');
        const collection = User.collection;
        const indexes = await collection.getIndexes();
        console.log('📋 Current Indexes:');
        Object.entries(indexes).forEach(([key, value]) => {
            console.log(`   - ${key}: ${JSON.stringify(value)}`);
        });
        console.log('');

        // 7. Sample of recent users
        console.log('🔎 Recent users (last 5)...');
        const recentUsers = await User.find()
            .sort({ createdAt: -1 })
            .limit(5)
            .lean();
        
        recentUsers.forEach((user, idx) => {
            console.log(`   ${idx + 1}. ID: ${user.id}, Username: @${user.username || 'N/A'}, Created: ${user.createdAt}`);
        });
        console.log('');

        // Final Summary
        console.log('═════════════════════════════════════════');
        console.log('📈 AUDIT SUMMARY:');
        console.log('═════════════════════════════════════════');
        console.log(`Total Users: ${totalUsers}`);
        console.log(`Duplicate IDs: ${duplicateIds.length}`);
        console.log(`Duplicate Usernames: ${duplicateUsernames.length}`);
        console.log(`Users without username: ${noUsername}`);
        console.log(`Data inconsistencies: ${issues.length}`);
        console.log('═════════════════════════════════════════\n');

        if (duplicateIds.length === 0 && duplicateUsernames.length === 0 && noUsername === 0 && issues.length === 0) {
            console.log('✅ DATABASE AUDIT PASSED - No issues found!\n');
        } else {
            console.log('⚠️  DATABASE AUDIT COMPLETED - See issues above\n');
        }

        process.exit(0);
    } catch (error) {
        console.error('❌ Error during audit:', error);
        process.exit(1);
    } finally {
        await mongoose.disconnect();
    }
}

// Run audit
auditUsers();
