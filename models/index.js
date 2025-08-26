const mongoose = require('mongoose');

function generateOrderId() {
    return Array.from({ length: 6 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 36)]).join('');
}

const buyOrderSchema = new mongoose.Schema({
    id: String,
    telegramId: String,
    username: String,
    amount: Number,
    stars: Number,
    premiumDuration: Number,
    walletAddress: String,
    isPremium: Boolean,
    status: String,
    dateCreated: Date,
    adminMessages: Array,
    recipients: [{ username: String, userId: String }],
    quantity: { type: Number, default: 1 }
});

const sellOrderSchema = new mongoose.Schema({
    id: {
        type: String,
        required: true,
        unique: true
    },
    telegramId: {
        type: String,
        required: true
    },
    username: String,
    stars: {
        type: Number,
        required: true
    },
    walletAddress: String,
    memoTag: String,
    status: {
        type: String,
        enum: ['pending', 'processing', 'completed', 'declined', 'reversed', 'refunded', 'failed', 'expired'],
        default: 'pending'
    },
    telegram_payment_charge_id: {
        type: String,
        required: function() {
            return this.dateCreated > new Date('2025-05-25');
        },
        default: null
    },
    reversible: {
        type: Boolean,
        default: true
    },
    sessionToken: {
        type: String,
        default: null
    },
    sessionExpiry: {
        type: Date,
        default: null
    },
    userLocked: {
        type: String,
        default: null
    },
    reversalData: {
        requested: Boolean,
        reason: String,
        status: {
            type: String,
            enum: ['none', 'requested', 'approved', 'rejected', 'processed'],
            default: 'none'
        },
        adminId: String,
        processedAt: Date
    },
    refundData: {
        requested: Boolean,
        reason: String,
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
        default: Date.now
    },
    dateCompleted: Date,
    dateReversed: Date,
    dateRefunded: Date,
    datePaid: Date,
    dateDeclined: Date
});

const userSchema = new mongoose.Schema({
    id: String,
    telegramId: String,
    username: String,
    firstName: String,
    lastName: String,
    referredBy: String,
    referralDate: Date,
    joinDate: { type: Date, default: Date.now },
    lastSeen: { type: Date, default: Date.now },
    isActive: { type: Boolean, default: true },
    inactiveDate: Date
});

const bannedUserSchema = new mongoose.Schema({
    users: Array
});

const cacheSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    username: { type: String, required: true },
    date: { type: Date, default: Date.now }
});

const referralSchema = new mongoose.Schema({
    referrerId: { type: String, required: true },
    referredId: { type: String, required: true },
    referredUsername: String,
    status: { type: String, enum: ['pending', 'active', 'completed', 'expired'], default: 'pending' },
    withdrawn: { type: Boolean, default: false },
    dateCreated: { type: Date, default: Date.now },
    activatedDate: Date,
    activationOrderId: String,
    starsPurchased: Number,
    expiredDate: Date
});

const referralWithdrawalSchema = new mongoose.Schema({
    withdrawalId: {
        type: String,
        required: true,
        unique: true,
        default: () => generateOrderId()
    },
    userId: String,
    username: String,
    amount: Number,
    walletAddress: String,
    referralIds: [{
        type: String,
        ref: 'Referral'
    }],
    status: {
        type: String,
        enum: ['pending', 'completed', 'declined'],
        default: 'pending'
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

const referralTrackerSchema = new mongoose.Schema({
    referral: { type: mongoose.Schema.Types.ObjectId, ref: 'Referral' },
    referrerUserId: { type: String, required: true },
    referredUserId: { type: String, required: true, unique: true },
    referredUsername: String,
    totalBoughtStars: { type: Number, default: 0 },
    totalSoldStars: { type: Number, default: 0 },
    premiumActivated: { type: Boolean, default: false },
    status: { type: String, enum: ['pending', 'active'], default: 'pending' },
    dateReferred: { type: Date, default: Date.now },
    dateActivated: Date
});

const feedbackSchema = new mongoose.Schema({
    orderId: { type: String, required: true },
    telegramId: { type: String, required: true },
    username: String,
    satisfaction: { type: Number, min: 1, max: 5 },
    reasons: String,
    suggestions: String,
    additionalInfo: String,
    dateSubmitted: { type: Date, default: Date.now }
});

const reversalSchema = new mongoose.Schema({
    orderId: { type: String, required: true },
    telegramId: { type: String, required: true },
    username: String,
    stars: { type: Number, required: true },
    reason: { type: String, required: true },
    status: { type: String, enum: ['pending', 'processing', 'completed', 'declined', 'failed'], default: 'pending' },
    adminId: String,
    adminUsername: String,
    processedAt: Date,
    createdAt: { type: Date, default: Date.now },
    adminMessages: [{
        adminId: String,
        messageId: Number,
        originalText: String,
        messageType: {
            type: String,
            enum: ['order', 'refund', 'reversal']
        }
    }],
    errorMessage: String
});

const warningSchema = new mongoose.Schema({
    userId: { type: String, required: true },
    type: { type: String, enum: ['warning', 'ban'], required: true },
    reason: { type: String, required: true },
    issuedBy: { type: String, required: true },
    issuedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date },
    isActive: { type: Boolean, default: true },
    autoRemove: { type: Boolean, default: false }
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
        default: 'Notification'
    },
    message: {
        type: String,
        required: true
    },
    actionUrl: String,
    icon: {
        type: String,
        default: 'fa-bell'
    },
    timestamp: {
        type: Date,
        default: Date.now,
        index: true
    },
    isGlobal: {
        type: Boolean,
        default: false
    },
    read: {
        type: Boolean,
        default: false,
        index: true
    },
    createdBy: {
        type: String,
        default: 'system'
    },
    priority: {
        type: Number,
        default: 0,
        min: 0,
        max: 2
    },
    type: {
        type: String,
        default: 'system',
        enum: ['system', 'order_completed', 'order_cancelled', 'payment_received', 'refund_processed', 'referral_activated', 'system_maintenance', 'new_feature', 'security_alert', 'welcome', 'reminder', 'manual', 'global']
    }
});

const stickerSchema = new mongoose.Schema({
  file_id: { type: String, required: true },
  file_unique_id: { type: String, required: true, unique: true },
  file_path: { type: String },
  is_animated: { type: Boolean, default: false },
  is_video: { type: Boolean, default: false },
  emoji: { type: String },
  set_name: { type: String },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now }
});

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