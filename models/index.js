const mongoose = require('mongoose');

function generateOrderId() {
    return Array.from({ length: 6 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 36)]).join('');
}

const buyOrderSchema = new mongoose.Schema({
    id: { 
        type: String, 
        required: true, 
        unique: true,
        index: true 
    },
    telegramId: { 
        type: String, 
        required: true,
        index: true 
    },
    username: { 
        type: String, 
        required: true 
    },
    amount: { 
        type: Number, 
        required: true,
        min: 0 
    },
    stars: { 
        type: Number,
        min: 0 
    },
    premiumDuration: { 
        type: Number,
        enum: [3, 6, 12] 
    },
    walletAddress: { 
        type: String, 
        required: true 
    },
    isPremium: { 
        type: Boolean, 
        default: false 
    },
    status: { 
        type: String, 
        enum: ['pending', 'processing', 'completed', 'declined', 'failed'],
        default: 'pending',
        index: true 
    },
    dateCreated: { 
        type: Date, 
        default: Date.now,
        index: true 
    },
    dateCompleted: { 
        type: Date,
        index: true 
    },
    dateDeclined: { 
        type: Date 
    },
    adminMessages: [{
        adminId: String,
        messageId: Number,
        originalText: String,
        messageType: {
            type: String,
            enum: ['order', 'refund', 'reversal']
        }
    }],
    recipients: [{ 
        username: { type: String, required: true },
        userId: { type: String, required: true }
    }],
    quantity: { 
        type: Number, 
        default: 1,
        min: 1,
        max: 5 
    }
});

const sellOrderSchema = new mongoose.Schema({
    id: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    telegramId: {
        type: String,
        required: true,
        index: true
    },
    username: { 
        type: String,
        required: true 
    },
    stars: {
        type: Number,
        required: true,
        min: 1
    },
    walletAddress: { 
        type: String,
        required: true 
    },
    memoTag: { 
        type: String,
        maxlength: 100 
    },
    status: {
        type: String,
        enum: ['pending', 'processing', 'completed', 'declined', 'reversed', 'refunded', 'failed', 'expired'],
        default: 'pending',
        index: true
    },
    telegram_payment_charge_id: {
        type: String,
        required: function() {
            return this.dateCreated > new Date('2025-05-25');
        },
        default: null,
        index: true
    },
    reversible: {
        type: Boolean,
        default: true
    },
    sessionToken: {
        type: String,
        default: null,
        index: true
    },
    sessionExpiry: {
        type: Date,
        default: null,
        index: true
    },
    userLocked: {
        type: String,
        default: null
    },
    reversalData: {
        requested: { type: Boolean, default: false },
        reason: { type: String, maxlength: 500 },
        status: {
            type: String,
            enum: ['none', 'requested', 'approved', 'rejected', 'processed'],
            default: 'none'
        },
        adminId: String,
        processedAt: Date
    },
    refundData: {
        requested: { type: Boolean, default: false },
        reason: { type: String, maxlength: 500 },
        status: {
            type: String,
            enum: ['none', 'requested', 'approved', 'rejected', 'processed'],
            default: 'none'
        },
        adminId: String,
        processedAt: Date,
        chargeId: String
    },
    adminMessages: [{
        adminId: String,
        messageId: Number,
        originalText: String,
        messageType: {
            type: String,
            enum: ['order', 'refund', 'reversal']
        }
    }],
    dateCreated: {
        type: Date,
        default: Date.now,
        index: true
    },
    dateCompleted: { 
        type: Date,
        index: true 
    },
    dateReversed: { 
        type: Date 
    },
    dateRefunded: { 
        type: Date 
    },
    datePaid: { 
        type: Date 
    },
    dateDeclined: { 
        type: Date 
    }
});

const userSchema = new mongoose.Schema({
    id: { 
        type: String, 
        unique: true,
        index: true 
    },
    telegramId: { 
        type: String, 
        unique: true,
        index: true 
    },
    username: { 
        type: String,
        index: true 
    },
    firstName: { 
        type: String,
        maxlength: 100 
    },
    lastName: { 
        type: String,
        maxlength: 100 
    },
    referredBy: { 
        type: String,
        index: true 
    },
    referralDate: { 
        type: Date 
    },
    joinDate: { 
        type: Date, 
        default: Date.now,
        index: true 
    },
    lastSeen: { 
        type: Date, 
        default: Date.now,
        index: true 
    },
    isActive: { 
        type: Boolean, 
        default: true,
        index: true 
    },
    inactiveDate: { 
        type: Date 
    }
});

const bannedUserSchema = new mongoose.Schema({
    users: [{ 
        type: String,
        index: true 
    }]
});

const cacheSchema = new mongoose.Schema({
    id: { 
        type: String, 
        required: true, 
        unique: true,
        index: true 
    },
    username: { 
        type: String, 
        required: true 
    },
    date: { 
        type: Date, 
        default: Date.now,
        index: true 
    }
});

const referralSchema = new mongoose.Schema({
    referrerId: { 
        type: String, 
        required: true,
        index: true 
    },
    referredId: { 
        type: String, 
        required: true,
        index: true 
    },
    referredUsername: { 
        type: String,
        index: true 
    },
    status: { 
        type: String, 
        enum: ['pending', 'active', 'completed', 'expired'], 
        default: 'pending',
        index: true 
    },
    withdrawn: { 
        type: Boolean, 
        default: false,
        index: true 
    },
    dateCreated: { 
        type: Date, 
        default: Date.now,
        index: true 
    },
    activatedDate: { 
        type: Date,
        index: true 
    },
    activationOrderId: { 
        type: String,
        index: true 
    },
    starsPurchased: { 
        type: Number,
        min: 0 
    },
    expiredDate: { 
        type: Date,
        index: true 
    }
});

const referralWithdrawalSchema = new mongoose.Schema({
    withdrawalId: {
        type: String,
        required: true,
        unique: true,
        default: () => generateOrderId(),
        index: true
    },
    userId: { 
        type: String,
        required: true,
        index: true 
    },
    username: { 
        type: String,
        required: true 
    },
    amount: { 
        type: Number,
        required: true,
        min: 0.01 
    },
    walletAddress: { 
        type: String,
        required: true 
    },
    referralIds: [{
        type: String,
        ref: 'Referral',
        index: true
    }],
    status: {
        type: String,
        enum: ['pending', 'completed', 'declined', 'expired'],
        default: 'pending',
        index: true
    },
    createdAt: {
        type: Date,
        default: Date.now,
        index: true
    },
    processedAt: { 
        type: Date 
    },
    processedBy: { 
        type: String 
    },
    adminReason: { 
        type: String,
        maxlength: 500 
    }
});

const referralTrackerSchema = new mongoose.Schema({
    referral: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'Referral',
        index: true 
    },
    referrerUserId: { 
        type: String, 
        required: true,
        index: true 
    },
    referredUserId: { 
        type: String, 
        required: true, 
        unique: true,
        index: true 
    },
    referredUsername: { 
        type: String,
        index: true 
    },
    totalBoughtStars: { 
        type: Number, 
        default: 0,
        min: 0 
    },
    totalSoldStars: { 
        type: Number, 
        default: 0,
        min: 0 
    },
    premiumActivated: { 
        type: Boolean, 
        default: false,
        index: true 
    },
    status: { 
        type: String, 
        enum: ['pending', 'active'], 
        default: 'pending',
        index: true 
    },
    dateReferred: { 
        type: Date, 
        default: Date.now,
        index: true 
    },
    dateActivated: { 
        type: Date,
        index: true 
    }
});

const feedbackSchema = new mongoose.Schema({
    orderId: { 
        type: String, 
        required: true,
        index: true 
    },
    telegramId: { 
        type: String, 
        required: true,
        index: true 
    },
    username: { 
        type: String,
        index: true 
    },
    satisfaction: { 
        type: Number, 
        min: 1, 
        max: 5,
        required: true 
    },
    reasons: { 
        type: String,
        maxlength: 1000 
    },
    suggestions: { 
        type: String,
        maxlength: 1000 
    },
    additionalInfo: { 
        type: String,
        maxlength: 1000 
    },
    dateSubmitted: { 
        type: Date, 
        default: Date.now,
        index: true 
    }
});

const reversalSchema = new mongoose.Schema({
    orderId: { 
        type: String, 
        required: true,
        index: true 
    },
    telegramId: { 
        type: String, 
        required: true,
        index: true 
    },
    username: { 
        type: String,
        index: true 
    },
    stars: { 
        type: Number, 
        required: true,
        min: 1 
    },
    reason: { 
        type: String, 
        required: true,
        maxlength: 500 
    },
    status: { 
        type: String, 
        enum: ['pending', 'processing', 'completed', 'declined', 'failed'], 
        default: 'pending',
        index: true 
    },
    adminId: { 
        type: String,
        index: true 
    },
    adminUsername: { 
        type: String 
    },
    processedAt: { 
        type: Date,
        index: true 
    },
    createdAt: { 
        type: Date, 
        default: Date.now,
        index: true 
    },
    adminMessages: [{
        adminId: String,
        messageId: Number,
        originalText: String,
        messageType: {
            type: String,
            enum: ['order', 'refund', 'reversal']
        }
    }],
    errorMessage: { 
        type: String,
        maxlength: 500 
    }
});

const warningSchema = new mongoose.Schema({
    userId: { 
        type: String, 
        required: true,
        index: true 
    },
    type: { 
        type: String, 
        enum: ['warning', 'ban'], 
        required: true,
        index: true 
    },
    reason: { 
        type: String, 
        required: true,
        maxlength: 500 
    },
    issuedBy: { 
        type: String, 
        required: true 
    },
    issuedAt: { 
        type: Date, 
        default: Date.now,
        index: true 
    },
    expiresAt: { 
        type: Date,
        index: true 
    },
    isActive: { 
        type: Boolean, 
        default: true,
        index: true 
    },
    autoRemove: { 
        type: Boolean, 
        default: false 
    }
});

const notificationSchema = new mongoose.Schema({
    userId: {
        type: String,
        default: 'all',
        index: true
    },
    title: {
        type: String,
        required: true,
        default: 'Notification',
        maxlength: 200
    },
    message: {
        type: String,
        required: true,
        maxlength: 2000
    },
    actionUrl: { 
        type: String,
        maxlength: 500 
    },
    icon: {
        type: String,
        default: 'fa-bell',
        maxlength: 50
    },
    timestamp: {
        type: Date,
        default: Date.now,
        index: true
    },
    isGlobal: {
        type: Boolean,
        default: false,
        index: true
    },
    read: {
        type: Boolean,
        default: false,
        index: true
    },
    createdBy: {
        type: String,
        default: 'system',
        maxlength: 100
    },
    priority: {
        type: Number,
        default: 0,
        min: 0,
        max: 2,
        index: true
    },
    type: {
        type: String,
        default: 'system',
        enum: ['system', 'order_completed', 'order_cancelled', 'payment_received', 'refund_processed', 'referral_activated', 'system_maintenance', 'new_feature', 'security_alert', 'welcome', 'reminder', 'manual', 'global'],
        index: true
    }
});

const stickerSchema = new mongoose.Schema({
  file_id: { 
      type: String, 
      required: true,
      index: true 
  },
  file_unique_id: { 
      type: String, 
      required: true, 
      unique: true,
      index: true 
  },
  file_path: { 
      type: String 
  },
  is_animated: { 
      type: Boolean, 
      default: false,
      index: true 
  },
  is_video: { 
      type: Boolean, 
      default: false,
      index: true 
  },
  emoji: { 
      type: String,
      index: true 
  },
  set_name: { 
      type: String,
      index: true 
  },
  created_at: { 
      type: Date, 
      default: Date.now,
      index: true 
  },
  updated_at: { 
      type: Date, 
      default: Date.now,
      index: true 
  }
});

// Create compound indexes for better query performance
buyOrderSchema.index({ telegramId: 1, status: 1 });
buyOrderSchema.index({ telegramId: 1, dateCreated: -1 });
sellOrderSchema.index({ telegramId: 1, status: 1 });
sellOrderSchema.index({ telegramId: 1, dateCreated: -1 });
referralSchema.index({ referrerId: 1, status: 1 });
referralSchema.index({ referrerId: 1, dateCreated: -1 });
referralWithdrawalSchema.index({ userId: 1, status: 1 });
referralWithdrawalSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, read: 1 });
notificationSchema.index({ userId: 1, timestamp: -1 });

const Sticker = mongoose.model('Sticker', stickerSchema);
const Notification = mongoose.model('Notification', notificationSchema);
const Warning = mongoose.model('Warning', warningSchema);
const Reversal = mongoose.model('Reversal', reversalSchema);
const Feedback = mongoose.model('Feedback', feedbackSchema);
const ReferralTracker = mongoose.model('ReferralTracker', referralTrackerSchema);
const ReferralWithdrawal = mongoose.model('ReferralWithdrawal', referralWithdrawalSchema);
const Cache = mongoose.model('Cache', cacheSchema);
const BuyOrder = mongoose.model('BuyOrder', buyOrderSchema);
const SellOrder = mongoose.model('SellOrder', sellOrderSchema);
const User = mongoose.model('User', userSchema);
const Referral = mongoose.model('Referral', referralSchema);
const BannedUser = mongoose.model('BannedUser', bannedUserSchema);

module.exports = {
    Sticker,
    Notification,
    Warning,
    Reversal,
    Feedback,
    ReferralTracker,
    ReferralWithdrawal,
    Cache,
    BuyOrder,
    SellOrder,
    User,
    Referral,
    BannedUser
};