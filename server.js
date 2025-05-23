require('dotenv').config();
const mongoose = require('mongoose');

// 1. Modern connection without deprecated options
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => {
    console.error('Connection error:', err);
    process.exit(1);
  });

// 2. Your exact schema (unchanged)
const sellOrderSchema = new mongoose.Schema({
  id: String,
  telegramId: String,
  username: String,
  stars: Number,
  walletAddress: String,
  status: String,
  refundRequested: { type: Boolean, default: false },
  refundStatus: { 
    type: String, 
    enum: ['none', 'requested', 'approved', 'processed', 'denied'],
    default: 'none' 
  },
  dateCreated: Date
});

const SellOrder = mongoose.model('SellOrder', sellOrderSchema);

// 3. Enhanced migration with better reporting
async function migrate() {
  try {
    console.log('Starting migration...');
    
    // Find documents needing updates
    const docsToUpdate = await SellOrder.find({
      $or: [
        { telegram_payment_charge_id: { $exists: false } },
        { refundRequested: { $exists: false } },
        { refundStatus: { $exists: false } }
      ]
    }).lean();

    if (docsToUpdate.length === 0) {
      console.log('✅ All documents are already up-to-date');
      process.exit(0);
    }

    // Process updates
    const bulkOps = docsToUpdate.map(doc => ({
      updateOne: {
        filter: { _id: doc._id },
        update: {
          $set: {
            telegram_payment_charge_id: doc.telegram_payment_charge_id || "",
            refundRequested: doc.refundRequested || false,
            refundStatus: doc.refundStatus || "none"
          }
        }
      }
    }));

    const result = await SellOrder.bulkWrite(bulkOps);
    
    // Detailed report
    console.log('\nMigration Report:');
    console.log('----------------');
    console.log(`Documents needing update: ${docsToUpdate.length}`);
    console.log(`Successfully updated: ${result.modifiedCount}`);
    console.log(`Already up-to-date: ${docsToUpdate.length - result.modifiedCount}`);
    
    if (result.modifiedCount === docsToUpdate.length) {
      console.log('\n✅ All required documents updated successfully');
    } else {
      console.log('\n⚠️ Note: Some documents were already up-to-date (not an error)');
    }

    process.exit(0);
  } catch (err) {
    console.error('\n❌ Migration failed:', err.message);
    process.exit(1);
  }
}

migrate();
