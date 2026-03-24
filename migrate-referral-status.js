#!/usr/bin/env node

const mongoose = require('mongoose');
require('dotenv').config();

const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/tg-star-store';

// Define Referral schema
const referralSchema = new mongoose.Schema({
    referrerUserId: String,
    referredUserId: String,
    status: { type: String, enum: ['pending', 'active', 'completed'], default: 'pending' },
    withdrawn: Boolean,
    dateReferred: Date,
    dateCreated: Date,
    dateActivated: Date
}, { collection: 'referrals', timestamps: true });

async function migrate() {
    try {
        console.log('Connecting to MongoDB...');
        await mongoose.connect(mongoUri);
        console.log('✓ Connected to MongoDB\n');

        const Referral = mongoose.model('Referral', referralSchema);

        // Get status counts before migration
        console.log('Status counts BEFORE migration:');
        const beforeCounts = await Referral.aggregate([
            { $group: { _id: '$status', count: { $sum: 1 } } }
        ]);
        beforeCounts.forEach(item => {
            console.log(`  ${item._id || 'null'}: ${item.count}`);
        });
        console.log();

        // Run migration
        console.log('Running migration: completed -> active...');
        const result = await Referral.updateMany(
            { status: 'completed' },
            { $set: { status: 'active' } }
        );
        
        console.log(`✓ Updated ${result.modifiedCount} referrals\n`);

        // Get status counts after migration
        console.log('Status counts AFTER migration:');
        const afterCounts = await Referral.aggregate([
            { $group: { _id: '$status', count: { $sum: 1 } } }
        ]);
        afterCounts.forEach(item => {
            console.log(`  ${item._id || 'null'}: ${item.count}`);
        });

        // Show sample of migrated referrals
        console.log('\nSample of migrated referrals (status=active):');
        const samples = await Referral.find({ status: 'active' }).limit(5);
        samples.forEach((ref, i) => {
            console.log(`  ${i+1}. Referrer: ${ref.referrerUserId.substring(0, 8)}... -> Referred: ${ref.referredUserId.substring(0, 8)}... (withdrawn: ${ref.withdrawn ? 'yes' : 'no'})`);
        });

        console.log('\n✓ Migration complete!');
        process.exit(0);

    } catch (error) {
        console.error('❌ Migration failed:', error.message);
        process.exit(1);
    }
}

migrate();
