 require('dotenv').config();
const mongoose = require('mongoose');

// Database connection with enhanced error handling
async function connectDB() {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000
    });
    console.log('✅ MongoDB connected successfully');
  } catch (err) {
    console.error('❌ MongoDB connection error:', err.message);
    process.exit(1);
  }
}

// Migration script with detailed reporting
async function migrateReferrals() {
  await connectDB();

  // Define your schemas
  const referralSchema = new mongoose.Schema({
    referredUserId: String,
    referrerUserId: String,
    status: String,
    dateReferred: Date,
    dateCompleted: Date,
    withdrawn: { type: Boolean, default: false }
  });

  const Referral = mongoose.model('Referral', referralSchema);

  // Analysis phase - show current state
  console.log('\n📊 PRE-MIGRATION ANALYSIS');
  const referralStats = await Referral.aggregate([
    {
      $group: {
        _id: '$referrerUserId',
        totalReferrals: { $sum: 1 },
        completedReferrals: {
          $sum: { $cond: [{ $in: ['$status', ['completed', 'active']] }, 1, 0] }
        },
        pendingReferrals: {
          $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] }
        }
      }
    },
    { $sort: { totalReferrals: -1 } }
  ]);

  console.log('📌 Referral Statistics by User:');
  console.table(referralStats.map(stat => ({
    'User ID': stat._id,
    'Total Referrals': stat.totalReferrals,
    'Completed': stat.completedReferrals,
    'Pending': stat.pendingReferrals
  })));

  // Migration phase
  console.log('\n🔄 STARTING MIGRATION');
  try {
    const updateResult = await Referral.updateMany(
      { withdrawn: { $exists: false } },
      { $set: { withdrawn: false } }
    );

    console.log('✅ MIGRATION COMPLETE');
    console.log(`   Total documents: ${updateResult.matchedCount}`);
    console.log(`   Successfully updated: ${updateResult.modifiedCount}`);
    console.log(`   Failed updates: ${updateResult.matchedCount - updateResult.modifiedCount}`);

    // Post-migration verification
    const verification = await Referral.aggregate([
      {
        $group: {
          _id: null,
          withField: { $sum: { $cond: [{ $ifNull: ["$withdrawn", false] }, 1, 0] } },
          total: { $sum: 1 }
        }
      }
    ]);

    console.log('\n🔍 POST-MIGRATION VERIFICATION:');
    console.log(`   Documents with 'withdrawn' field: ${verification[0].withField}/${verification[0].total}`);
    console.log(`   Migration success rate: ${((verification[0].withField/verification[0].total)*100).toFixed(2)}%`);

    // Sample check
    const sample = await Referral.aggregate([{ $sample: { size: 5 } }]);
    console.log('\n🔎 SAMPLE DOCUMENTS:');
    console.table(sample.map(doc => ({
      id: doc._id,
      referrer: doc.referrerUserId,
      status: doc.status,
      withdrawn: doc.withdrawn
    })));

    process.exit(0);
  } catch (err) {
    console.error('❌ MIGRATION FAILED:', err.message);
    process.exit(1);
  }
}

// Execute the migration
migrateReferrals();
