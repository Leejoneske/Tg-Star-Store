 require('dotenv').config();
const mongoose = require('mongoose');

// 1. Use the EXACT same connection as your main server
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
});

// 2. Use your EXACT existing schema (no changes)
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

// 3. Migration function
async function migrate() {
  try {
    console.log('Starting migration...');
    
    const result = await SellOrder.updateMany(
      { 
        $or: [
          { telegram_payment_charge_id: { $exists: false } },
          { refundRequested: { $exists: false } },
          { refundStatus: { $exists: false } }
        ]
      },
      {
        $set: {
          telegram_payment_charge_id: "",
          refundRequested: false,
          refundStatus: "none"
        }
      }
    );

    console.log('\nMigration Report:');
    console.log('----------------');
    console.log(`Total documents: ${result.matchedCount}`);
    console.log(`Successfully updated: ${result.modifiedCount}`);
    console.log(`Failed: ${result.matchedCount - result.modifiedCount}`);
    
    if (result.modifiedCount === result.matchedCount) {
      console.log('\n✅ All documents updated successfully');
    } else {
      console.log('\n⚠️ Some documents may not have been updated');
    }

    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  }
}

migrate();
